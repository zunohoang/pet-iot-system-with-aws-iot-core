'use strict';

/**
 * Backend API Lambda — invoked by API Gateway (ANY /{proxy+})
 *
 * Routes:
 *   GET    /devices                           List devices owned by authenticated user
 *   GET    /devices/:deviceId                 Get single device + shadow state
 *   POST   /devices/:deviceId/shadow          Update desired shadow state (remote control)
 *   GET    /devices/:deviceId/telemetry       Query telemetry history from Timestream
 *
 *   POST   /devices/claim                     User pre-claims a device by claim code (scan QR)
 *   POST   /devices/claim/auto                User requests auto claim code by device type
 *   GET    /devices/claim/:claimId            Check claim status for a claim code
 *   POST   /devices/provisioning-claim         Fleet Provisioning (Trusted User): short-lived cert for device setup
 *   POST   /admin/claims                      Admin pre-registers a device claim token
 *
 *   GET    /scenes                            List scenes for authenticated user
 *   POST   /scenes                            Create a new scene
 *   PUT    /scenes/:sceneId                   Update a scene
 *   DELETE /scenes/:sceneId                   Delete a scene
 *   POST   /scenes/:sceneId/run               Run a scene immediately
 *
 *   POST   /ota/deploy                        Deploy OTA update
 *   GET    /ota/jobs                          List OTA jobs
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand,
        DeleteCommand, GetCommand, BatchGetCommand } = require('@aws-sdk/lib-dynamodb');
const { IoTClient, DescribeThingCommand, CreateProvisioningClaimCommand } = require('@aws-sdk/client-iot');
const { IoTDataPlaneClient, GetThingShadowCommand, UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { randomUUID } = require('crypto');

const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iotClient = new IoTClient({});
const iotData   = new IoTDataPlaneClient({});
const smClient  = new SecretsManagerClient({});

const DEVICES_TABLE      = process.env.DYNAMODB_DEVICES_TABLE;
const USER_DEVICE_TABLE  = process.env.USER_DEVICE_TABLE;
const CLAIMS_TABLE       = process.env.DYNAMODB_CLAIMS_TABLE;
const SCENES_TABLE       = process.env.DYNAMODB_SCENES_TABLE;
const OTA_JOBS_TABLE     = process.env.DYNAMODB_OTA_JOBS_TABLE;
const INFLUXDB_URL       = process.env.INFLUXDB_URL;
const INFLUXDB_BUCKET    = process.env.INFLUXDB_BUCKET;
const INFLUXDB_SECRET    = process.env.INFLUXDB_SECRET_ARN;

let _influxToken = null;
async function getInfluxToken() {
    if (_influxToken) return _influxToken;
    const result = await smClient.send(new GetSecretValueCommand({ SecretId: INFLUXDB_SECRET }));
    const secret = JSON.parse(result.SecretString);
    _influxToken = secret['influxdb-token'] || secret.password;
    return _influxToken;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */
function ok(body)         { return { statusCode: 200, headers: cors(), body: JSON.stringify(body) }; }
function created(body)    { return { statusCode: 201, headers: cors(), body: JSON.stringify(body) }; }
function err(code, msg)   { return { statusCode: code, headers: cors(), body: JSON.stringify({ error: msg }) }; }
function cors() {
    return {
        'Content-Type':  'application/json',
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    };
}

function getUserId(event) {
    return event.requestContext?.authorizer?.claims?.sub || 'anonymous';
}

/* ── Device routes ────────────────────────────────────────────────────── */

/**
 * List all devices owned by this user.
 *
 * Flow:
 *   1. Query user-device-mapping table by userId (correct table — hash_key=userId)
 *   2. BatchGet device details from the devices table for each deviceId
 *   3. Merge ownership metadata with device details and return
 */
async function listDevices(userId) {
    /* Step 1: get all deviceIds this user owns */
    const mappingResult = await dynamo.send(new QueryCommand({
        TableName:              USER_DEVICE_TABLE,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
    }));

    const mappings = mappingResult.Items || [];
    if (mappings.length === 0) return ok([]);

    /* Step 2: batch-fetch device details in one round-trip */
    const keys = mappings.map(m => ({ deviceId: m.deviceId }));

    const batchResult = await dynamo.send(new BatchGetCommand({
        RequestItems: {
            [DEVICES_TABLE]: { Keys: keys },
        },
    }));

    const deviceDetails = (batchResult.Responses?.[DEVICES_TABLE] || []);
    const detailsMap    = Object.fromEntries(deviceDetails.map(d => [d.deviceId, d]));

    /* Step 3: merge ownership metadata with device details */
    const devices = mappings.map(mapping => ({
        ...detailsMap[mapping.deviceId],  /* device registry data */
        userId:       mapping.userId,
        deviceId:     mapping.deviceId,
        deviceType:   mapping.deviceType,
        claimId:      mapping.claimId || mapping.serialNumber || null,
        claimedAt:    mapping.claimedAt,
        provisionedAt: mapping.provisionedAt,
    }));

    return ok(devices);
}

/** Get one device and its current IoT shadow state. */
async function getDevice(userId, deviceId) {
    /* Ownership check: verify user owns this device */
    const mapping = await dynamo.send(new GetCommand({
        TableName: USER_DEVICE_TABLE,
        Key: { userId, deviceId },
    }));

    if (!mapping.Item) {
        return err(403, 'Device not found or access denied');
    }

    let shadow = null;
    try {
        const res = await iotData.send(new GetThingShadowCommand({ thingName: deviceId }));
        shadow = JSON.parse(Buffer.from(res.payload).toString());
    } catch {
        /* shadow may not exist yet for a freshly provisioned device */
    }

    let thingAttrs = null;
    try {
        const thing = await iotClient.send(new DescribeThingCommand({ thingName: deviceId }));
        thingAttrs = thing.attributes;
    } catch {}

    return ok({
        ...mapping.Item,
        shadow,
        attributes: thingAttrs,
    });
}

/** Update the desired state of a device's shadow (remote control). */
async function updateShadow(userId, deviceId, desiredState) {
    /* Ownership check */
    const mapping = await dynamo.send(new GetCommand({
        TableName: USER_DEVICE_TABLE,
        Key: { userId, deviceId },
    }));
    if (!mapping.Item) return err(403, 'Device not found or access denied');

    const payload = JSON.stringify({ state: { desired: desiredState } });
    await iotData.send(new UpdateThingShadowCommand({
        thingName: deviceId,
        payload:   Buffer.from(payload),
    }));
    return ok({ message: 'Shadow updated', desired: desiredState });
}

/**
 * Query historical telemetry from Timestream for InfluxDB using InfluxQL
 * via the v1 compatibility endpoint: GET /query?db={bucket}&q={influxql}
 */
async function getTelemetry(userId, deviceId, minutes = 60) {
    /* Ownership check */
    const mapping = await dynamo.send(new GetCommand({
        TableName: USER_DEVICE_TABLE,
        Key: { userId, deviceId },
    }));
    if (!mapping.Item) return err(403, 'Device not found or access denied');

    const token = await getInfluxToken();

    /* InfluxQL query — selects temperature and humidity for this device */
    const influxql =
        `SELECT "value" FROM "temperature","humidity" ` +
        `WHERE "deviceId"='${deviceId}' ` +
        `AND time > now() - ${minutes}m ` +
        `ORDER BY time DESC LIMIT 200`;

    const url = `${INFLUXDB_URL}/query?` +
        `db=${encodeURIComponent(INFLUXDB_BUCKET)}&` +
        `q=${encodeURIComponent(influxql)}&epoch=ms`;

    try {
        const resp = await fetch(url, {
            headers: { Authorization: `Token ${token}` },
        });

        if (!resp.ok) {
            console.error('InfluxDB query HTTP error:', resp.status, await resp.text());
            return ok([]);
        }

        const data = await resp.json();

        /* Flatten multi-series InfluxQL response into [{time, measure, value}] */
        const rows = [];
        for (const result of data.results || []) {
            for (const series of result.series || []) {
                const timeIdx  = series.columns.indexOf('time');
                const valueIdx = series.columns.indexOf('value');
                for (const point of series.values || []) {
                    rows.push({
                        time:    point[timeIdx],
                        measure: series.name,          /* "temperature" or "humidity" */
                        value:   point[valueIdx],
                    });
                }
            }
        }

        rows.sort((a, b) => b.time - a.time);
        return ok(rows);

    } catch (e) {
        console.error('InfluxDB query error:', e);
        return ok([]);
    }
}

/* ── Claim routes ─────────────────────────────────────────────────────── */

/**
 * User claims a device by entering its claim code (e.g. from scanning a QR code).
 *
 * Rules enforced by UpdateCommand ConditionExpression:
 *   - Claim token must exist (admin pre-registered it): attribute_exists(claimId)
 *   - Claim must not yet be owned by anyone:            attribute_not_exists(userId)
 *   - Claim must not already be used (device on):       used = :false
 *
 * This prevents:
 *   - Claiming a device that was never registered
 *   - Stealing a device already claimed by another user
 *   - Claiming a device that has already been provisioned
 */
async function claimDevice(claimId, userId) {
    if (!claimId) return err(400, 'claimId is required');

    const now = new Date().toISOString();

    try {
        await dynamo.send(new UpdateCommand({
            TableName:        CLAIMS_TABLE,
            Key:              { claimId },
            UpdateExpression: 'SET userId = :uid, claimedAt = :now',
            ConditionExpression:
                'attribute_exists(claimId) AND attribute_not_exists(userId) AND #used = :false',
            ExpressionAttributeNames: { '#used': 'used' },
            ExpressionAttributeValues: {
                ':uid':   userId,
                ':now':   now,
                ':false': false,
            },
        }));

        return ok({
            claimId,
            status:  'waiting_device',
            message: 'Device claimed successfully. Power on the device to complete setup.',
        });

    } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') {
            /* Determine the exact reason for the user-facing message */
            const check = await dynamo.send(new GetCommand({
                TableName: CLAIMS_TABLE,
                Key: { claimId },
            }));

            if (!check.Item) {
                return err(404, 'Device not found. Check the claim code and try again.');
            }
            if (check.Item.userId && check.Item.userId !== userId) {
                return err(409, 'This device is already registered to another account.');
            }
            if (check.Item.used) {
                return err(409, 'This device has already been provisioned.');
            }
        }
        throw e;
    }
}

/**
 * Auto-claim flow: backend creates a short-lived claim code and binds it to user immediately.
 * Used by mobile BLE setup where users choose device type instead of entering claim code manually.
 */
async function autoClaimDevice(deviceType, userId) {
    if (userId === 'anonymous') return err(401, 'Authentication required');
    if (!['switch', 'sensor'].includes(deviceType)) {
        return err(400, 'deviceType must be "switch" or "sensor"');
    }

    const now = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + (60 * 30); /* 30 minutes */

    for (let i = 0; i < 5; i += 1) {
        const claimId = `C${randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`;
        try {
            await dynamo.send(new PutCommand({
                TableName: CLAIMS_TABLE,
                Item: {
                    claimId,
                    deviceType,
                    userId,
                    used: false,
                    createdAt: now,
                    claimedAt: now,
                    source: 'mobile-auto-claim',
                    expiresAt,
                },
                ConditionExpression: 'attribute_not_exists(claimId)',
            }));

            return created({
                claimId,
                deviceType,
                status: 'waiting_device',
                message: 'Claim code created. Continue BLE setup within 30 minutes.',
                expiresAt,
            });
        } catch (e) {
            if (e.name !== 'ConditionalCheckFailedException') throw e;
        }
    }

    return err(500, 'Failed to allocate claim code');
}

/** Check the provisioning status of a claim code (for post-QR-scan polling). */
async function getClaimStatus(claimId) {
    if (!claimId) return err(400, 'claimId is required');

    const result = await dynamo.send(new GetCommand({
        TableName: CLAIMS_TABLE,
        Key: { claimId },
    }));

    if (!result.Item) {
        return err(404, 'Claim not found');
    }

    const { deviceType, userId, used, usedAt, thingName, claimedAt } = result.Item;

    let status;
    if (used)          status = 'provisioned';
    else if (userId)   status = 'waiting_device';
    else               status = 'available';

    return ok({ claimId, status, deviceType, userId, claimedAt, thingName, provisionedAt: usedAt });
}

/**
 * Trusted User: return a short-lived X.509 claim cert + private key (CreateProvisioningClaim)
 * for the device to complete Fleet Provisioning over MQTT. Caller must have claimed
 * the claim code in the app; deviceType selects Switch vs Sensor template.
 */
async function postProvisioningClaim(claimId, userId) {
    if (!claimId) return err(400, 'claimId is required');
    if (userId === 'anonymous') return err(401, 'Authentication required');

    const result = await dynamo.send(new GetCommand({
        TableName: CLAIMS_TABLE,
        Key: { claimId },
    }));

    const claim = result.Item;
    if (!claim) {
        return err(404, 'Device not found. Check the claim code.');
    }
    if (claim.used) {
        return err(409, 'This device has already been provisioned.');
    }
    if (!claim.userId) {
        return err(403, 'Claim this device in the app before provisioning.');
    }
    if (claim.userId !== userId) {
        return err(403, 'This device is not claimed by your account.');
    }

    const project     = process.env.PROJECT_NAME;
    const deviceType  = claim.deviceType || 'switch';
    const templateName = deviceType === 'sensor'
        ? `${project}-SensorTemplate`
        : `${project}-SwitchTemplate`;

    let out;
    try {
        out = await iotClient.send(new CreateProvisioningClaimCommand({ templateName }));
    } catch (e) {
        console.error('CreateProvisioningClaim error:', e.name, e.message);
        return err(502, 'Failed to create provisioning claim');
    }

    const privateKey = out.keyPair?.PrivateKey
        || out.keyPair?.privateKey
        || out.keyPair?.private_key;
    if (!out.certificatePem || !privateKey) {
        console.error('CreateProvisioningClaim: empty certificate or private key in response');
        return err(502, 'Provisioning service error');
    }

    const iotDataEndpoint = process.env.IOT_DATA_ENDPOINT;
    if (!iotDataEndpoint) {
        console.error('IOT_DATA_ENDPOINT is not set');
    }

    console.log('CreateProvisioningClaim ok', {
        claimId,
        templateName,
        expiration: out.expiration,
    });

    return ok({
        claimId,
        deviceType,
        templateName,
        certificatePem:  out.certificatePem,
        privateKey,
        certificateId:   out.certificateId,
        expiration:      out.expiration,
        iotDataEndpoint: iotDataEndpoint || null,
    });
}

/* ── Admin routes ─────────────────────────────────────────────────────── */

/** Admin pre-registers a device claim token before shipment. */
async function adminRegisterClaim(claimId, deviceType) {
    if (!claimId || !deviceType) {
        return err(400, 'claimId and deviceType are required');
    }

    await dynamo.send(new PutCommand({
        TableName: CLAIMS_TABLE,
        Item: {
            claimId,
            deviceType,
            used:       false,
            createdAt:  new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(claimId)',
    }));

    return created({ claimId, deviceType, status: 'available' });
}

/* ── Scene routes ─────────────────────────────────────────────────────── */
async function listScenes(userId) {
    const result = await dynamo.send(new QueryCommand({
        TableName:              SCENES_TABLE,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
    }));
    return ok(result.Items || []);
}

async function createScene(userId, body) {
    const { name, trigger, actions, enabled = true } = body;
    if (!name || !trigger || !actions) {
        return err(400, 'name, trigger, and actions are required');
    }

    const scene = {
        userId,
        sceneId:   randomUUID(),
        name,
        trigger,
        actions,
        enabled:   String(enabled),
        createdAt: new Date().toISOString(),
    };

    await dynamo.send(new PutCommand({ TableName: SCENES_TABLE, Item: scene }));
    return created(scene);
}

async function updateScene(userId, sceneId, body) {
    const { name, trigger, actions, enabled } = body;

    const updateExpr = [];
    const attrValues = {};
    const attrNames  = {};

    if (name    !== undefined) { updateExpr.push('#name = :name');      attrNames['#name'] = 'name'; attrValues[':name']    = name; }
    if (trigger !== undefined) { updateExpr.push('trigger = :trigger'); attrValues[':trigger'] = trigger; }
    if (actions !== undefined) { updateExpr.push('actions = :actions'); attrValues[':actions'] = actions; }
    if (enabled !== undefined) { updateExpr.push('enabled = :enabled'); attrValues[':enabled'] = String(enabled); }

    if (updateExpr.length === 0) return err(400, 'No fields to update');

    await dynamo.send(new UpdateCommand({
        TableName:        SCENES_TABLE,
        Key:              { userId, sceneId },
        UpdateExpression: `SET ${updateExpr.join(', ')}`,
        ConditionExpression: 'attribute_exists(sceneId)',
        ExpressionAttributeNames:  attrNames,
        ExpressionAttributeValues: attrValues,
    }));

    return ok({ message: 'Scene updated' });
}

async function deleteScene(userId, sceneId) {
    await dynamo.send(new DeleteCommand({
        TableName: SCENES_TABLE,
        Key:       { userId, sceneId },
    }));
    return ok({ message: 'Scene deleted' });
}

async function runScene(userId, sceneId) {
    const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
    const lambda = new LambdaClient({});
    await lambda.send(new InvokeCommand({
        FunctionName:   process.env.PROJECT_NAME + '-scene-engine',
        InvocationType: 'Event',
        Payload:        Buffer.from(JSON.stringify({ userId, sceneId })),
    }));
    return ok({ message: `Scene ${sceneId} triggered` });
}

/* ── OTA routes ───────────────────────────────────────────────────────── */
async function listOtaJobs(deviceType) {
    const result = await dynamo.send(new QueryCommand({
        TableName:              OTA_JOBS_TABLE,
        IndexName:              'deviceType-createdAt-index',
        KeyConditionExpression: 'deviceType = :type',
        ExpressionAttributeValues: { ':type': deviceType || 'switch' },
        Limit:           20,
        ScanIndexForward: false,
    }));
    return ok(result.Items || []);
}

/* ── Router ───────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
    console.log('API event:', JSON.stringify({ method: event.httpMethod, path: event.path }));

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: cors(), body: '' };
    }

    const method = event.httpMethod;
    let path   = event.path || '';
    /* API Gateway may pass /v1/devices/... when stage is in path */
    if (path.match(/^\/v\d+\//)) {
        path = path.replace(/^\/v\d+/, '') || '/';
    }
    const userId = getUserId(event);
    const parts  = path.replace(/^\//, '').split('/');
    const qs     = event.queryStringParameters || {};

    let body;
    try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }

    try {
        /* ── /devices ── */
        if (parts[0] === 'devices') {
            const seg1 = parts[1];  /* deviceId or "claim" or undefined */
            const seg2 = parts[2];  /* sub-resource or claimId */

            /* GET  /devices  → list owned devices */
            if (!seg1 && method === 'GET') return listDevices(userId);

            /* POST /devices/claim  → user pre-claims device via QR */
            if (seg1 === 'claim' && !seg2 && method === 'POST')
                return claimDevice(body.claimId || body.serialNumber, userId);

            /* POST /devices/claim/auto  → auto-issue claim for selected device type */
            if (seg1 === 'claim' && seg2 === 'auto' && method === 'POST')
                return autoClaimDevice(body.deviceType, userId);

            /* GET  /devices/claim/:claimId  → check claim status */
            if (seg1 === 'claim' && seg2 && method === 'GET')
                return getClaimStatus(seg2);

            /* POST /devices/provisioning-claim  → short-lived cert (Trusted User) */
            if (seg1 === 'provisioning-claim' && !seg2 && method === 'POST')
                return postProvisioningClaim(body.claimId || body.serialNumber, userId);

            /* Routes that require a real deviceId (not the literal "claim" segment) */
            const deviceId = seg1 && seg1 !== 'claim' ? seg1 : null;

            if (deviceId) {
                if (!seg2 && method === 'GET')
                    return getDevice(userId, deviceId);

                if (seg2 === 'shadow' && method === 'POST')
                    return updateShadow(userId, deviceId, body);

                if (seg2 === 'telemetry' && method === 'GET')
                    return getTelemetry(userId, deviceId, parseInt(qs.minutes || '60'));
            }
        }

        /* ── /admin ── */
        if (parts[0] === 'admin') {
            if (parts[1] === 'claims' && method === 'POST')
                return adminRegisterClaim(body.claimId || body.serialNumber, body.deviceType);
        }

        /* ── /scenes ── */
        if (parts[0] === 'scenes') {
            const sceneId = parts[1];

            if (!sceneId && method === 'GET')    return listScenes(userId);
            if (!sceneId && method === 'POST')   return createScene(userId, body);
            if (sceneId  && method === 'PUT')    return updateScene(userId, sceneId, body);
            if (sceneId  && method === 'DELETE') return deleteScene(userId, sceneId);
            if (sceneId  && method === 'POST' && parts[2] === 'run')
                return runScene(userId, sceneId);
        }

        /* ── /ota ── */
        if (parts[0] === 'ota') {
            if (parts[1] === 'deploy' && method === 'POST') {
                const otaHandler = require('../ota-manager/handler');
                return otaHandler.handler(event);
            }
            if (parts[1] === 'jobs' && method === 'GET')
                return listOtaJobs(qs.deviceType);
        }

        return err(404, `Route not found: ${method} ${path}`);

    } catch (e) {
        console.error('API error:', e);
        return err(500, 'Internal server error');
    }
};

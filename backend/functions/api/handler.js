'use strict';

/**
 * Backend API Lambda — invoked by API Gateway (ANY /{proxy+})
 *
 * Routes:
 *   GET    /devices                          List devices for authenticated user
 *   GET    /devices/:deviceId                Get single device + shadow state
 *   POST   /devices/:deviceId/shadow         Update desired shadow state
 *   GET    /devices/:deviceId/telemetry      Query telemetry history from Timestream
 *   POST   /devices/:deviceId/claim          Register a new device claim token
 *
 *   GET    /scenes                           List scenes for authenticated user
 *   POST   /scenes                           Create a new scene
 *   PUT    /scenes/:sceneId                  Update a scene
 *   DELETE /scenes/:sceneId                  Delete a scene
 *   POST   /scenes/:sceneId/run              Run a scene immediately
 *
 *   POST   /ota/deploy                       Deploy OTA update (delegates to OTA handler)
 *   GET    /ota/jobs                         List OTA jobs
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand,
        DeleteCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { IoTClient, DescribeThingCommand } = require('@aws-sdk/client-iot');
const { IoTDataPlaneClient, GetThingShadowCommand, UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');
const { TimestreamQueryClient, QueryCommand: TSQueryCommand } = require('@aws-sdk/client-timestream-query');
const { randomUUID } = require('crypto');

const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iotClient = new IoTClient({});
const iotData   = new IoTDataPlaneClient({});
const tsQuery   = new TimestreamQueryClient({});

const DEVICES_TABLE  = process.env.DYNAMODB_DEVICES_TABLE;
const CLAIMS_TABLE   = process.env.DYNAMODB_CLAIMS_TABLE;
const SCENES_TABLE   = process.env.DYNAMODB_SCENES_TABLE;
const OTA_JOBS_TABLE = process.env.DYNAMODB_OTA_JOBS_TABLE;
const TS_DB          = process.env.TIMESTREAM_DATABASE;
const TS_TABLE       = process.env.TIMESTREAM_TABLE;

/* ── Helpers ──────────────────────────────────────────────────────────── */
function ok(body)   { return { statusCode: 200, headers: cors(), body: JSON.stringify(body) }; }
function err(code, msg) { return { statusCode: code, headers: cors(), body: JSON.stringify({ error: msg }) }; }
function cors() {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    };
}

function getUserId(event) {
    /* Cognito User Pool authorizer injects claims into requestContext */
    return event.requestContext?.authorizer?.claims?.sub || 'anonymous';
}

/* ── Device routes ────────────────────────────────────────────────────── */
async function listDevices(userId) {
    const result = await dynamo.send(new QueryCommand({
        TableName:              DEVICES_TABLE,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
    }));
    return ok(result.Items || []);
}

async function getDevice(deviceId) {
    let shadow = null;
    try {
        const res = await iotData.send(new GetThingShadowCommand({ thingName: deviceId }));
        shadow = JSON.parse(Buffer.from(res.payload).toString());
    } catch (e) {
        /* shadow may not exist yet */
    }

    let thing = null;
    try {
        thing = await iotClient.send(new DescribeThingCommand({ thingName: deviceId }));
    } catch {}

    return ok({ deviceId, shadow, attributes: thing?.attributes });
}

async function updateShadow(deviceId, desiredState) {
    const payload = JSON.stringify({ state: { desired: desiredState } });
    await iotData.send(new UpdateThingShadowCommand({
        thingName: deviceId,
        payload:   Buffer.from(payload),
    }));
    return ok({ message: 'Shadow updated', desired: desiredState });
}

async function getTelemetry(deviceId, minutes = 60) {
    const query = `
        SELECT time, measure_name, measure_value::double
        FROM "${TS_DB}"."${TS_TABLE}"
        WHERE deviceId = '${deviceId}'
          AND time > ago(${minutes}m)
        ORDER BY time DESC
        LIMIT 200
    `;

    try {
        const result = await tsQuery.send(new TSQueryCommand({ QueryString: query }));
        const rows = (result.Rows || []).map(row => {
            const cells = row.Data;
            return {
                time:     cells[0]?.ScalarValue,
                measure:  cells[1]?.ScalarValue,
                value:    parseFloat(cells[2]?.ScalarValue),
            };
        });
        return ok(rows);
    } catch (e) {
        console.error('Timestream query error:', e);
        return ok([]);
    }
}

async function registerClaimToken(serialNumber, deviceType, userId) {
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; /* 7 days */
    await dynamo.send(new PutCommand({
        TableName: CLAIMS_TABLE,
        Item: {
            claimId:     serialNumber,
            deviceType,
            userId,
            used:        false,
            createdAt:   new Date().toISOString(),
            expiresAt,
        },
    }));
    return ok({ claimId: serialNumber, expiresAt });
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
    return ok(scene);
}

async function updateScene(userId, sceneId, body) {
    const { name, trigger, actions, enabled } = body;

    const updateExpr = [];
    const attrValues = {};
    const attrNames  = {};

    if (name    !== undefined) { updateExpr.push('#name = :name');       attrNames['#name'] = 'name';    attrValues[':name']    = name; }
    if (trigger !== undefined) { updateExpr.push('trigger = :trigger');  attrValues[':trigger'] = trigger; }
    if (actions !== undefined) { updateExpr.push('actions = :actions');  attrValues[':actions'] = actions; }
    if (enabled !== undefined) { updateExpr.push('enabled = :enabled');  attrValues[':enabled'] = String(enabled); }

    if (updateExpr.length === 0) return err(400, 'No fields to update');

    attrValues[':uid'] = userId;
    attrValues[':sid'] = sceneId;

    await dynamo.send(new UpdateCommand({
        TableName:        SCENES_TABLE,
        Key:              { userId, sceneId },
        UpdateExpression: `SET ${updateExpr.join(', ')}`,
        ExpressionAttributeNames: attrNames,
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
async function listOtaJobs() {
    const result = await dynamo.send(new QueryCommand({
        TableName:                 OTA_JOBS_TABLE,
        IndexName:                 'deviceType-createdAt-index',
        KeyConditionExpression:    'deviceType = :type',
        ExpressionAttributeValues: { ':type': 'all' },
        Limit: 20,
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

    const method  = event.httpMethod;
    const path    = event.path || '';
    const userId  = getUserId(event);
    const parts   = path.replace(/^\//, '').split('/');
    let body;
    try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }

    try {
        /* /devices */
        if (parts[0] === 'devices') {
            const deviceId = parts[1];

            if (!deviceId && method === 'GET')  return listDevices(userId);
            if (deviceId  && method === 'GET' && !parts[2]) return getDevice(deviceId);
            if (deviceId  && method === 'POST' && parts[2] === 'shadow')
                return updateShadow(deviceId, body);
            if (deviceId  && method === 'GET'  && parts[2] === 'telemetry')
                return getTelemetry(deviceId, parseInt(event.queryStringParameters?.minutes || '60'));
            if (!deviceId && method === 'POST' && parts[1] === 'claim')
                return registerClaimToken(body.serialNumber, body.deviceType, userId);
        }

        /* /scenes */
        if (parts[0] === 'scenes') {
            const sceneId = parts[1];

            if (!sceneId && method === 'GET')    return listScenes(userId);
            if (!sceneId && method === 'POST')   return createScene(userId, body);
            if (sceneId  && method === 'PUT')    return updateScene(userId, sceneId, body);
            if (sceneId  && method === 'DELETE') return deleteScene(userId, sceneId);
            if (sceneId  && method === 'POST' && parts[2] === 'run')
                return runScene(userId, sceneId);
        }

        /* /ota */
        if (parts[0] === 'ota') {
            if (parts[1] === 'deploy' && method === 'POST') {
                /* Delegate to OTA manager Lambda (re-use handler directly) */
                const otaHandler = require('../ota-manager/handler');
                return otaHandler.handler(event);
            }
            if (parts[1] === 'jobs' && method === 'GET') return listOtaJobs();
        }

        return err(404, `Route not found: ${method} ${path}`);

    } catch (e) {
        console.error('API error:', e);
        return err(500, 'Internal server error');
    }
};

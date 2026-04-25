'use strict';

/**
 * Fleet Provisioning Pre-Provisioning Hook
 *
 * AWS IoT Core calls this Lambda BEFORE creating the Thing and certificate.
 * Works for both the legacy factory claim flow and **Fleet Provisioning (Trusted User)**,
 * where the device uses a **short-lived** cert from `CreateProvisioningClaim` — the same
 * template parameters and DynamoDB `device_claims` checks apply.
 *
 * Validation rules:
 *   1. claimId must exist in device-claims table (admin pre-registered it)
 *   2. claim must NOT already be used (prevents re-provisioning)
 *   3. claim.userId must be set (user must scan QR and pre-claim BEFORE powering device)
 *
 * On success:
 *   - Writes user → device mapping to user-device-mapping table
 *   - Writes device metadata to devices table
 *   - Marks claim as used (prevents replay)
 *   - Returns { allowProvisioning: true }
 *
 * ThingName derivation (must match Fleet Provisioning Template):
 *   deviceType "switch" → "switch-{claimId}"
 *   deviceType "sensor" → "sensor-{claimId}"
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CLAIMS_TABLE      = process.env.DYNAMODB_CLAIMS_TABLE;
const USER_DEVICE_TABLE = process.env.USER_DEVICE_TABLE;
const DEVICES_TABLE     = process.env.DYNAMODB_DEVICES_TABLE;

/** Derive the IoT Thing name from the Fleet Provisioning Template formula. */
function deriveThingName(deviceType, claimId) {
    const prefix = deviceType === 'sensor' ? 'sensor' : 'switch';
    return `${prefix}-${claimId}`;
}

exports.handler = async (event) => {
    console.log('PreProvisioningHook event:', JSON.stringify(event));

    const { parameters, claimCertificateId, clientId } = event;
    const claimId    = parameters?.ClaimId || parameters?.SerialNumber;
    const deviceType   = parameters?.DeviceType;

    if (!claimId) {
        console.warn('Rejected: missing ClaimId in provisioning parameters');
        return { allowProvisioning: false };
    }

    try {
        /* Step 1: Look up the claim token */
        const result = await dynamo.send(new GetCommand({
            TableName: CLAIMS_TABLE,
            Key: { claimId },
        }));

        const claim = result.Item;

        if (!claim) {
            console.warn(`Rejected: unknown claim token ${claimId}`);
            return { allowProvisioning: false };
        }

        /* Step 2: Prevent replay — claim must not already be used */
        if (claim.used) {
            console.warn(`Rejected: claim ${claimId} already used at ${claim.usedAt}`);
            return { allowProvisioning: false };
        }

        /* Step 3: Enforce pre-claiming — user must scan QR and claim BEFORE device boots.
         * This binds the device to a specific user account during provisioning. */
        if (!claim.userId) {
            console.warn(`Rejected: claim ${claimId} has no owner — user must claim device via app first`);
            return { allowProvisioning: false };
        }

        const resolvedDeviceType = deviceType || claim.deviceType || 'switch';
        const thingName          = deriveThingName(resolvedDeviceType, claimId);
        const now                = new Date().toISOString();

        console.log(`Provisioning approved: claimId=${claimId} thingName=${thingName} owner=${claim.userId}`);

        /* Step 4: Write all DynamoDB records atomically (best-effort; no saga needed for MVP) */
        await Promise.all([
            /* 4a. Bind device to user in the ownership mapping table */
            dynamo.send(new PutCommand({
                TableName: USER_DEVICE_TABLE,
                Item: {
                    userId:       claim.userId,
                    deviceId:     thingName,
                    deviceType:   resolvedDeviceType,
                    claimId,
                    claimedAt:    claim.claimedAt || now,
                    provisionedAt: now,
                },
                /* Prevent overwrite if user already has this device linked */
                ConditionExpression: 'attribute_not_exists(deviceId)',
            })),

            /* 4b. Register the device in the global device registry */
            dynamo.send(new PutCommand({
                TableName: DEVICES_TABLE,
                Item: {
                    deviceId:      thingName,
                    deviceType:    resolvedDeviceType,
                    claimId,
                    ownerId:       claim.userId,
                    status:        'provisioned',
                    firmwareVersion: parameters?.FirmwareVersion || '1.0.0',
                    provisionedAt: now,
                    lastSeen:      now,
                },
            })),

            /* 4c. Mark claim token as consumed */
            dynamo.send(new UpdateCommand({
                TableName: CLAIMS_TABLE,
                Key: { claimId },
                UpdateExpression: 'SET #used = :true, usedAt = :now, thingName = :thing, claimCertId = :certId, clientId = :cid',
                ConditionExpression: '#used = :false',
                ExpressionAttributeNames: { '#used': 'used' },
                ExpressionAttributeValues: {
                    ':true':   true,
                    ':false':  false,
                    ':now':    now,
                    ':thing':  thingName,
                    ':certId': claimCertificateId || '',
                    ':cid':    clientId || '',
                },
            })),
        ]);

        return { allowProvisioning: true };

    } catch (err) {
        /* ConditionalCheckFailedException on the claim mark means a race condition —
         * another provisioning attempt won, so reject this one. */
        if (err.name === 'ConditionalCheckFailedException') {
            console.warn(`Race condition on claim ${claimId} — rejecting duplicate`);
            return { allowProvisioning: false };
        }

        console.error('PreProvisioningHook unexpected error:', err);
        return { allowProvisioning: false };
    }
};

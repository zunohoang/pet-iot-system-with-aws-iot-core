'use strict';

/**
 * Fleet Provisioning Pre-Provisioning Hook
 *
 * AWS IoT Core calls this Lambda BEFORE creating the Thing and certificate.
 * We validate that the claim token (serialNumber) is registered and unused.
 * Return { allowProvisioning: true } to proceed, false to reject.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CLAIMS_TABLE = process.env.DYNAMODB_CLAIMS_TABLE;

exports.handler = async (event) => {
    console.log('PreProvisioningHook event:', JSON.stringify(event));

    const { parameters, claimCertificateId, clientId } = event;
    const serialNumber  = parameters?.SerialNumber;
    const deviceType    = parameters?.DeviceType;

    if (!serialNumber) {
        console.warn('Missing SerialNumber in provisioning parameters');
        return { allowProvisioning: false };
    }

    try {
        /* Look up the pre-registered claim token in DynamoDB.
         * Claim tokens are inserted by an admin API before devices ship. */
        const result = await dynamo.send(new GetCommand({
            TableName: CLAIMS_TABLE,
            Key: { claimId: serialNumber },
        }));

        const claim = result.Item;

        if (!claim) {
            console.warn(`Unknown claim: ${serialNumber}`);
            return { allowProvisioning: false };
        }

        if (claim.used) {
            console.warn(`Claim already used: ${serialNumber}`);
            return { allowProvisioning: false };
        }

        /* Mark claim as used to prevent replay attacks */
        await dynamo.send(new UpdateCommand({
            TableName: CLAIMS_TABLE,
            Key: { claimId: serialNumber },
            UpdateExpression: 'SET #used = :true, usedAt = :now, claimCertId = :certId, clientId = :cid',
            ExpressionAttributeNames: { '#used': 'used' },
            ExpressionAttributeValues: {
                ':true':   true,
                ':now':    new Date().toISOString(),
                ':certId': claimCertificateId,
                ':cid':    clientId,
            },
        }));

        console.log(`Provisioning approved for serial=${serialNumber} type=${deviceType}`);
        return { allowProvisioning: true };

    } catch (err) {
        console.error('PreProvisioningHook error:', err);
        return { allowProvisioning: false };
    }
};

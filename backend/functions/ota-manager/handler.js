'use strict';

/**
 * OTA Manager Lambda
 *
 * POST /ota/deploy
 * Body: { version, deviceType, deviceIds?, checksum? }
 *
 * Steps:
 * 1. Verify firmware binary exists in S3
 * 2. Generate presigned S3 URL (24h TTL)
 * 3. Create AWS IoT Job targeting specified devices
 * 4. Record job in DynamoDB for tracking
 */

const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { IoTClient, CreateJobCommand, DescribeJobCommand, ListThingGroupsForThingCommand } = require('@aws-sdk/client-iot');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');

const s3     = new S3Client({});
const iot    = new IoTClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const FIRMWARE_BUCKET  = process.env.FIRMWARE_BUCKET;
const OTA_JOBS_TABLE   = process.env.DYNAMODB_OTA_JOBS_TABLE;
const AWS_REGION       = process.env.AWS_REGION_NAME;

/** Build the S3 key for a firmware binary: firmware/{deviceType}/v{version}/firmware.bin */
function firmwareKey(deviceType, version) {
    return `firmware/${deviceType}/v${version}/firmware.bin`;
}

/** Build ARNs for IoT Thing Group targets */
function thingGroupArn(groupName) {
    return `arn:aws:iot:${AWS_REGION}:*:thinggroup/${groupName}`;
}

exports.handler = async (event) => {
    console.log('OTA deploy event:', JSON.stringify(event));

    let body;
    try {
        body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { version, deviceType, deviceIds, checksum } = body;

    if (!version || !deviceType) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'version and deviceType are required' }),
        };
    }

    const s3Key = firmwareKey(deviceType, version);

    /* 1. Verify firmware exists in S3 */
    try {
        await s3.send(new HeadObjectCommand({ Bucket: FIRMWARE_BUCKET, Key: s3Key }));
    } catch (err) {
        console.error('Firmware not found in S3:', s3Key, err);
        return {
            statusCode: 404,
            body: JSON.stringify({ error: `Firmware ${version} for ${deviceType} not found in S3` }),
        };
    }

    /* 2. Generate presigned download URL (24h TTL) */
    const presignedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: FIRMWARE_BUCKET, Key: s3Key }),
        { expiresIn: 86400 }
    );

    /* 3. Determine targets */
    let targets;
    if (deviceIds && deviceIds.length > 0) {
        /* Target specific things by ARN */
        targets = deviceIds.map(id =>
            `arn:aws:iot:${AWS_REGION}:*:thing/${id}`
        );
    } else {
        /* Target entire device type group */
        const groupName = deviceType === 'switch'
            ? 'iot-smarthome-switches'
            : 'iot-smarthome-sensors';
        targets = [thingGroupArn(groupName)];
    }

    const jobId = `ota-${deviceType}-v${version.replace(/\./g, '-')}-${Date.now()}`;

    const jobDocument = {
        operation:  'firmware_update',
        version,
        url:        presignedUrl,
        checksum:   checksum || '',
        deviceType,
    };

    /* 4. Create IoT Job */
    await iot.send(new CreateJobCommand({
        jobId,
        targets,
        document:            JSON.stringify(jobDocument),
        description:         `OTA update to v${version} for ${deviceType} devices`,
        targetSelection:     'SNAPSHOT',
        jobExecutionsRolloutConfig: {
            maximumPerMinute: 10,
        },
        timeoutConfig: {
            inProgressTimeoutInMinutes: 30,
        },
    }));

    /* 5. Record in DynamoDB */
    await dynamo.send(new PutCommand({
        TableName: OTA_JOBS_TABLE,
        Item: {
            jobId,
            version,
            deviceType,
            deviceIds:    deviceIds || [],
            targets,
            s3Key,
            status:       'IN_PROGRESS',
            createdAt:    new Date().toISOString(),
        },
    }));

    console.log(`OTA job created: ${jobId} for ${targets.join(', ')}`);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jobId,
            version,
            deviceType,
            targets,
            message: `OTA job created successfully`,
        }),
    };
};

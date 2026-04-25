'use strict';

/**
 * IoT Processor Lambda
 *
 * Triggered by AWS IoT Rule Engine for all telemetry on devices/+/telemetry.
 *
 * Actions:
 * - Write temperature / humidity to Timestream for InfluxDB (via InfluxDB Line Protocol)
 * - Update device last-seen in DynamoDB
 * - Send SNS alert when threshold exceeded
 */

const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const smClient  = new SecretsManagerClient({});
const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const snsClient = new SNSClient({});

const INFLUXDB_URL    = process.env.INFLUXDB_URL;
const INFLUXDB_ORG    = process.env.INFLUXDB_ORG;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET;
const INFLUXDB_SECRET = process.env.INFLUXDB_SECRET_ARN;
const DEVICES_TABLE   = process.env.DYNAMODB_DEVICES_TABLE;
const SNS_TOPIC_ARN   = process.env.SNS_ALERT_TOPIC_ARN;

const TEMP_THRESHOLD     = 35;
const HUMIDITY_THRESHOLD = 80;

/* Cache token for the Lambda container lifetime (avoid SM call on every invocation) */
let _influxToken = null;

async function getInfluxToken() {
    if (_influxToken) return _influxToken;

    const result = await smClient.send(new GetSecretValueCommand({
        SecretId: INFLUXDB_SECRET,
    }));

    const secret = JSON.parse(result.SecretString);
    /* AWS auto-creates this secret with key "influxdb-token" */
    _influxToken = secret['influxdb-token'] || secret.password;
    return _influxToken;
}

/**
 * Write telemetry points using InfluxDB Line Protocol.
 * Each measurement (temperature / humidity) becomes a separate InfluxDB field
 * tagged with the deviceId for easy per-device querying in InfluxQL.
 */
async function writeToInfluxDB(deviceId, temperature, humidity) {
    const token  = await getInfluxToken();
    const client = new InfluxDB({ url: INFLUXDB_URL, token });
    const writeApi = client.getWriteApi(INFLUXDB_ORG, INFLUXDB_BUCKET, 'ms');

    if (temperature !== undefined && temperature !== null) {
        writeApi.writePoint(
            new Point('temperature')
                .tag('deviceId', deviceId)
                .floatField('value', temperature)
        );
    }

    if (humidity !== undefined && humidity !== null) {
        writeApi.writePoint(
            new Point('humidity')
                .tag('deviceId', deviceId)
                .floatField('value', humidity)
        );
    }

    await writeApi.close();
}

async function updateDeviceStatus(deviceId, data) {
    const updateParts = ['SET lastSeen = :ts', '#dtype = :type'];
    const attrValues  = {
        ':ts':   new Date().toISOString(),
        ':type': data.deviceType || 'sensor',
    };
    const attrNames = { '#dtype': 'deviceType' };

    if (data.temperature !== undefined) {
        updateParts.push('lastTemperature = :temp');
        attrValues[':temp'] = data.temperature;
    }
    if (data.humidity !== undefined) {
        updateParts.push('lastHumidity = :hum');
        attrValues[':hum'] = data.humidity;
    }

    await dynamo.send(new UpdateCommand({
        TableName:                DEVICES_TABLE,
        Key:                      { deviceId },
        UpdateExpression:         updateParts.join(', '),
        ExpressionAttributeNames: attrNames,
        ExpressionAttributeValues: attrValues,
    }));
}

async function sendAlert(deviceId, message, data) {
    await snsClient.send(new PublishCommand({
        TopicArn: SNS_TOPIC_ARN,
        Subject:  `[IoT Alert] ${message}`,
        Message:  JSON.stringify({
            alert:     message,
            deviceId,
            timestamp: new Date().toISOString(),
            data,
        }),
        MessageAttributes: {
            deviceId:  { DataType: 'String', StringValue: deviceId },
            alertType: { DataType: 'String', StringValue: 'threshold' },
        },
    }));
}

exports.handler = async (event) => {
    console.log('IoT event:', JSON.stringify(event));

    const { deviceId, temperature, humidity, deviceType } = event;

    if (!deviceId) {
        console.warn('No deviceId in event — skipping');
        return;
    }

    const promises = [];

    /* Write to InfluxDB if sensor data is present */
    if (temperature !== undefined || humidity !== undefined) {
        promises.push(
            writeToInfluxDB(deviceId, temperature, humidity)
                .catch(err => console.error('InfluxDB write error:', err))
        );
    }

    /* Always update device last-seen in DynamoDB */
    promises.push(updateDeviceStatus(deviceId, event));

    /* Threshold alerts */
    if (temperature !== undefined && temperature > TEMP_THRESHOLD) {
        promises.push(sendAlert(
            deviceId,
            `High temperature: ${temperature}°C (threshold: ${TEMP_THRESHOLD}°C)`,
            { temperature }
        ));
    }
    if (humidity !== undefined && humidity > HUMIDITY_THRESHOLD) {
        promises.push(sendAlert(
            deviceId,
            `High humidity: ${humidity}% (threshold: ${HUMIDITY_THRESHOLD}%)`,
            { humidity }
        ));
    }

    await Promise.all(promises);
    console.log(`Processed telemetry for ${deviceId}`);
};

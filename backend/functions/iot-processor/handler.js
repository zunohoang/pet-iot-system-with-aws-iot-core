'use strict';

/**
 * IoT Processor Lambda
 *
 * Triggered by AWS IoT Rule Engine for:
 * 1. Telemetry events from devices/+/telemetry
 * 2. High-temperature/humidity alerts (WHERE clause in Rule SQL)
 *
 * Actions:
 * - Write telemetry to Timestream
 * - Update device status in DynamoDB
 * - Send SNS alert if threshold exceeded
 */

const { TimestreamWriteClient, WriteRecordsCommand } = require('@aws-sdk/client-timestream-write');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const tsClient  = new TimestreamWriteClient({});
const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const snsClient = new SNSClient({});

const TIMESTREAM_DB    = process.env.TIMESTREAM_DATABASE;
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE;
const DEVICES_TABLE    = process.env.DYNAMODB_DEVICES_TABLE;
const SNS_TOPIC_ARN    = process.env.SNS_ALERT_TOPIC_ARN;

const TEMP_THRESHOLD     = 35;
const HUMIDITY_THRESHOLD = 80;

async function writeToTimestream(deviceId, temperature, humidity) {
    const now = Date.now().toString();

    const records = [];

    if (temperature !== undefined) {
        records.push({
            MeasureName:  'temperature',
            MeasureValue: String(temperature),
            MeasureValueType: 'DOUBLE',
            Time: now,
            Dimensions: [{ Name: 'deviceId', Value: deviceId }],
        });
    }

    if (humidity !== undefined) {
        records.push({
            MeasureName:  'humidity',
            MeasureValue: String(humidity),
            MeasureValueType: 'DOUBLE',
            Time: now,
            Dimensions: [{ Name: 'deviceId', Value: deviceId }],
        });
    }

    if (records.length === 0) return;

    await tsClient.send(new WriteRecordsCommand({
        DatabaseName: TIMESTREAM_DB,
        TableName:    TIMESTREAM_TABLE,
        Records:      records,
    }));
}

async function updateDeviceStatus(deviceId, data) {
    await dynamo.send(new UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { deviceId },
        UpdateExpression: [
            'SET lastSeen = :ts',
            'deviceType = :type',
            data.temperature !== undefined ? 'lastTemperature = :temp' : null,
            data.humidity    !== undefined ? 'lastHumidity = :hum'     : null,
        ].filter(Boolean).join(', '),
        ExpressionAttributeValues: {
            ':ts':   new Date().toISOString(),
            ':type': data.deviceType || 'sensor',
            ...(data.temperature !== undefined && { ':temp': data.temperature }),
            ...(data.humidity    !== undefined && { ':hum':  data.humidity }),
        },
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
            deviceId: { DataType: 'String', StringValue: deviceId },
            alertType: { DataType: 'String', StringValue: 'threshold' },
        },
    }));
}

exports.handler = async (event) => {
    console.log('IoT event:', JSON.stringify(event));

    /* IoT Rule forwards a single telemetry payload */
    const {
        deviceId,
        temperature,
        humidity,
        deviceType,
    } = event;

    if (!deviceId) {
        console.warn('No deviceId in event');
        return;
    }

    const promises = [];

    /* Write to Timestream if sensor data present */
    if (temperature !== undefined || humidity !== undefined) {
        promises.push(writeToTimestream(deviceId, temperature, humidity));
    }

    /* Update device last-seen in DynamoDB */
    promises.push(updateDeviceStatus(deviceId, event));

    /* Threshold alerts */
    if (temperature !== undefined && temperature > TEMP_THRESHOLD) {
        promises.push(sendAlert(deviceId,
            `High temperature: ${temperature}°C (threshold: ${TEMP_THRESHOLD}°C)`,
            { temperature }
        ));
    }

    if (humidity !== undefined && humidity > HUMIDITY_THRESHOLD) {
        promises.push(sendAlert(deviceId,
            `High humidity: ${humidity}% (threshold: ${HUMIDITY_THRESHOLD}%)`,
            { humidity }
        ));
    }

    await Promise.all(promises);
    console.log(`Processed telemetry for ${deviceId}`);
};

'use strict';

/**
 * Scene Engine Lambda
 *
 * Executes smart home automation scenes. Triggered by:
 * 1. EventBridge scheduled rules (e.g. NightMode at 22:00)
 * 2. Direct invocation from IoT Processor when a threshold is exceeded
 * 3. API call from the mobile app to run a scene immediately
 *
 * Each scene has triggers and actions.
 * Actions update Device Shadow (desired state) which the device then acts on.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { IoTDataPlaneClient, UpdateThingShadowCommand } = require('@aws-sdk/client-iot-data-plane');

const dynamo    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iotData   = new IoTDataPlaneClient({});

const SCENES_TABLE = process.env.DYNAMODB_SCENES_TABLE;

/**
 * Apply a single scene action: update the target device's shadow desired state.
 */
async function applyAction(action) {
    const { deviceId, state } = action;

    if (!deviceId || !state) {
        console.warn('Invalid action:', action);
        return;
    }

    const shadowPayload = JSON.stringify({
        state: { desired: state },
    });

    await iotData.send(new UpdateThingShadowCommand({
        thingName: deviceId,
        payload:   Buffer.from(shadowPayload),
    }));

    console.log(`Applied scene action to ${deviceId}:`, state);
}

/**
 * Execute all actions for a given scene.
 */
async function executeScene(scene) {
    console.log(`Executing scene: ${scene.sceneId} (${scene.name})`);

    if (!Array.isArray(scene.actions) || scene.actions.length === 0) {
        console.warn(`Scene ${scene.sceneId} has no actions`);
        return;
    }

    await Promise.all(scene.actions.map(applyAction));
    console.log(`Scene ${scene.sceneId} complete`);
}

/**
 * Fetch all enabled scenes matching a trigger type.
 */
async function getScenesForTrigger(triggerType, scheduleName) {
    const result = await dynamo.send(new ScanCommand({
        TableName:        SCENES_TABLE,
        FilterExpression: '#enabled = :yes AND #trigger.#type = :ttype',
        ExpressionAttributeNames: {
            '#enabled': 'enabled',
            '#trigger': 'trigger',
            '#type':    'type',
        },
        ExpressionAttributeValues: {
            ':yes':   'true',
            ':ttype': triggerType,
        },
    }));

    let scenes = result.Items || [];

    /* Further filter by schedule name if provided */
    if (scheduleName) {
        scenes = scenes.filter(s =>
            s.trigger?.scheduleName === scheduleName
        );
    }

    return scenes;
}

exports.handler = async (event) => {
    console.log('SceneEngine event:', JSON.stringify(event));

    /* Case 1: EventBridge scheduled trigger */
    if (event.source === 'eventbridge-scheduler') {
        const scenes = await getScenesForTrigger('schedule', event.scheduleName);
        await Promise.all(scenes.map(executeScene));
        return { executed: scenes.length };
    }

    /* Case 2: Direct invocation with a specific sceneId */
    if (event.sceneId && event.userId) {
        const result = await dynamo.send(new QueryCommand({
            TableName:              SCENES_TABLE,
            KeyConditionExpression: 'userId = :uid AND sceneId = :sid',
            ExpressionAttributeValues: {
                ':uid': event.userId,
                ':sid': event.sceneId,
            },
        }));

        const scene = result.Items?.[0];
        if (!scene) {
            return { error: `Scene ${event.sceneId} not found` };
        }

        await executeScene(scene);
        return { executed: 1 };
    }

    /* Case 3: IoT threshold trigger (deviceId + alertType) */
    if (event.alertType === 'threshold' && event.deviceId) {
        const scenes = await getScenesForTrigger('threshold');
        const matching = scenes.filter(s =>
            s.trigger?.deviceId === event.deviceId ||
            s.trigger?.deviceId === '*'
        );
        await Promise.all(matching.map(executeScene));
        return { executed: matching.length };
    }

    console.warn('Unrecognized scene engine event:', event);
    return { executed: 0 };
};

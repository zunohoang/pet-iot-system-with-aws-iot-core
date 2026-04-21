// Lambda - IoT Processor (triggered by IoT Rule)
// Processes events from IoT Core, updates Device Shadow,
// stores telemetry to Timestream, sends alerts via SNS

exports.handler = async (event) => {
    // TODO: process IoT event, write to Timestream, trigger SNS if needed
    console.log('IoT event:', JSON.stringify(event));
};

// Lambda - Backend API (invoked by API Gateway)
// Handles HTTPS requests from Web/Mobile App

exports.handler = async (event) => {
    // TODO: route requests, interact with DynamoDB, IoT Core
    return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
};

output "api_gateway_url" {
  description = "REST API endpoint for the mobile app"
  value       = module.processing.api_gateway_url
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "Cognito App Client ID"
  value       = module.auth.user_pool_client_id
}

output "cognito_identity_pool_id" {
  description = "Cognito Identity Pool ID (for IoT WebSocket SigV4)"
  value       = module.auth.identity_pool_id
}

output "iot_data_endpoint" {
  description = "IoT Core data-ATS host (for MQTT and Trusted User app responses)"
  value       = data.aws_iot_endpoint.iot_data.endpoint_address
}

output "switch_provisioning_template" {
  value = module.provisioning.switch_template_name
}

output "sensor_provisioning_template" {
  value = module.provisioning.sensor_template_name
}

output "firmware_bucket" {
  value = module.ota.firmware_bucket_name
}

output "influxdb_endpoint" {
  description = "InfluxDB HTTPS endpoint (port 8086)"
  value       = module.data.influxdb_endpoint
}

output "influxdb_secret_arn" {
  description = "Secrets Manager ARN — contains InfluxDB admin token + credentials"
  value       = module.data.influxdb_secret_arn
}

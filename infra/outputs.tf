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

output "claim_certificate_pem" {
  description = "Claim certificate PEM — flash to device at factory"
  value       = module.provisioning.claim_certificate_pem
  sensitive   = true
}

output "claim_private_key" {
  description = "Claim private key — flash to device at factory"
  value       = module.provisioning.claim_private_key
  sensitive   = true
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

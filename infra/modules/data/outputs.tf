# ── InfluxDB outputs ──────────────────────────────────────────────────────────
output "influxdb_endpoint" {
  description = "Full HTTPS endpoint for the InfluxDB instance"
  value       = "https://${aws_timestreaminfluxdb_db_instance.main.endpoint}:8086"
}

output "influxdb_org" {
  value = aws_timestreaminfluxdb_db_instance.main.organization
}

output "influxdb_bucket" {
  value = aws_timestreaminfluxdb_db_instance.main.bucket
}

output "influxdb_secret_arn" {
  description = "Secrets Manager ARN containing admin token + credentials for InfluxDB"
  value       = aws_timestreaminfluxdb_db_instance.main.influx_auth_parameters_secret_arn
}

# ── DynamoDB outputs ──────────────────────────────────────────────────────────
output "devices_table_name" {
  value = aws_dynamodb_table.devices.name
}

output "devices_table_arn" {
  value = aws_dynamodb_table.devices.arn
}

output "user_device_table_name" {
  value = aws_dynamodb_table.user_device_mapping.name
}

output "user_device_table_arn" {
  value = aws_dynamodb_table.user_device_mapping.arn
}

output "device_claims_table_name" {
  value = aws_dynamodb_table.device_claims.name
}

output "device_claims_table_arn" {
  value = aws_dynamodb_table.device_claims.arn
}

output "scenes_table_name" {
  value = aws_dynamodb_table.scenes.name
}

output "scenes_table_arn" {
  value = aws_dynamodb_table.scenes.arn
}

output "ota_jobs_table_name" {
  value = aws_dynamodb_table.ota_jobs.name
}

output "ota_jobs_table_arn" {
  value = aws_dynamodb_table.ota_jobs.arn
}

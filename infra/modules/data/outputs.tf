output "timestream_database_name" {
  value = aws_timestreamwrite_database.telemetry.database_name
}

output "timestream_table_name" {
  value = aws_timestreamwrite_table.telemetry.table_name
}

output "devices_table_name" {
  value = aws_dynamodb_table.devices.name
}

output "devices_table_arn" {
  value = aws_dynamodb_table.devices.arn
}

output "user_device_table_name" {
  value = aws_dynamodb_table.user_device_mapping.name
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

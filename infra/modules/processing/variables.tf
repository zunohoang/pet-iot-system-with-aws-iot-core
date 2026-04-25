variable "project_name" {}
variable "aws_region" {}
variable "sns_topic_arn" {}
variable "dynamodb_devices_table_arn" {}
variable "dynamodb_devices_table_name" {}
variable "dynamodb_claims_table_arn" {}
variable "dynamodb_claims_table_name" {}
variable "dynamodb_scenes_table_arn" {}
variable "dynamodb_scenes_table_name" {}
variable "dynamodb_ota_jobs_table_arn" {}
variable "dynamodb_ota_jobs_table_name" {}
variable "firmware_bucket_arn" {}
variable "firmware_bucket_name" {}
variable "influxdb_url" {}
variable "influxdb_org" {}
variable "influxdb_bucket" {}
variable "influxdb_secret_arn" {}
variable "cognito_user_pool_arn" {}
variable "dynamodb_user_device_table_name" {}
variable "dynamodb_user_device_table_arn" {}
variable "iot_data_endpoint" {
  description = "AWS IoT data endpoint (ATS) for app/device MQTT/TLS"
}
variable "aws_account_id" {
  description = "Account ID for scoped IoT CreateProvisioningClaim ARNs"
}

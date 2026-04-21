terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

# ── Auth ─────────────────────────────────────────────────────────────────────
module "auth" {
  source       = "./modules/auth"
  project_name = var.project_name
}

# ── Data (DynamoDB + Timestream) ──────────────────────────────────────────────
module "data" {
  source       = "./modules/data"
  project_name = var.project_name
}

# ── Notification (SNS) ────────────────────────────────────────────────────────
module "notification" {
  source       = "./modules/notification"
  project_name = var.project_name
  alert_email  = var.alert_email
}

# ── OTA Storage (S3) ─────────────────────────────────────────────────────────
module "ota" {
  source       = "./modules/ota"
  project_name = var.project_name
}

# ── Processing (Lambda + API Gateway) ────────────────────────────────────────
module "processing" {
  source       = "./modules/processing"
  project_name = var.project_name
  aws_region   = var.aws_region

  sns_topic_arn                = module.notification.iot_alerts_topic_arn
  dynamodb_devices_table_arn   = module.data.devices_table_arn
  dynamodb_devices_table_name  = module.data.devices_table_name
  dynamodb_claims_table_arn    = module.data.device_claims_table_arn
  dynamodb_claims_table_name   = module.data.device_claims_table_name
  dynamodb_scenes_table_arn    = module.data.scenes_table_arn
  dynamodb_scenes_table_name   = module.data.scenes_table_name
  dynamodb_ota_jobs_table_arn  = module.data.ota_jobs_table_arn
  dynamodb_ota_jobs_table_name = module.data.ota_jobs_table_name
  firmware_bucket_arn          = module.ota.firmware_bucket_arn
  firmware_bucket_name         = module.ota.firmware_bucket_name
  timestream_database_name     = module.data.timestream_database_name
  timestream_table_name        = module.data.timestream_table_name
  cognito_user_pool_arn        = module.auth.user_pool_arn
}

# ── IoT Core (Policies + Rules) ───────────────────────────────────────────────
module "iot" {
  source       = "./modules/iot"
  project_name = var.project_name
  aws_region   = var.aws_region

  timestream_database_name    = module.data.timestream_database_name
  timestream_table_name       = module.data.timestream_table_name
  iot_processor_lambda_arn    = module.processing.iot_processor_lambda_arn
  scene_engine_lambda_arn     = module.processing.scene_engine_lambda_arn
  dynamodb_devices_table_name = module.data.devices_table_name
}

# ── Fleet Provisioning ────────────────────────────────────────────────────────
module "provisioning" {
  source       = "./modules/provisioning"
  project_name = var.project_name
  aws_region   = var.aws_region

  provisioning_hook_lambda_arn = module.processing.provisioning_hook_lambda_arn
  switch_policy_arn            = module.iot.switch_policy_arn
  sensor_policy_arn            = module.iot.sensor_policy_arn
  switch_thing_type            = module.iot.switch_thing_type_name
  sensor_thing_type            = module.iot.sensor_thing_type_name
  switches_group_name          = module.iot.switches_group_name
  sensors_group_name           = module.iot.sensors_group_name
}

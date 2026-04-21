# DynamoDB Tables

# ── User ↔ Device mapping ─────────────────────────────────────────────────────
resource "aws_dynamodb_table" "user_device_mapping" {
  name         = "${var.project_name}-user-device"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "deviceId"

  attribute {
    name = "userId"
    type = "S"
  }
  attribute {
    name = "deviceId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = false
  }

  tags = { Project = var.project_name }
}

# ── Device registry (status, shadow cache, metadata) ─────────────────────────
resource "aws_dynamodb_table" "devices" {
  name         = "${var.project_name}-devices"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "deviceId"

  attribute {
    name = "deviceId"
    type = "S"
  }
  attribute {
    name = "deviceType"
    type = "S"
  }

  global_secondary_index {
    name            = "deviceType-index"
    hash_key        = "deviceType"
    projection_type = "ALL"
  }

  tags = { Project = var.project_name }
}

# ── Device claim tokens (validated during Fleet Provisioning hook) ────────────
resource "aws_dynamodb_table" "device_claims" {
  name         = "${var.project_name}-device-claims"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "claimId"

  attribute {
    name = "claimId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = { Project = var.project_name }
}

# ── Smart Scenes / Automation Rules ──────────────────────────────────────────
resource "aws_dynamodb_table" "scenes" {
  name         = "${var.project_name}-scenes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "sceneId"

  attribute {
    name = "userId"
    type = "S"
  }
  attribute {
    name = "sceneId"
    type = "S"
  }
  attribute {
    name = "enabled"
    type = "S"
  }

  global_secondary_index {
    name            = "enabled-index"
    hash_key        = "enabled"
    range_key       = "sceneId"
    projection_type = "ALL"
  }

  tags = { Project = var.project_name }
}

# ── OTA Jobs tracking ─────────────────────────────────────────────────────────
resource "aws_dynamodb_table" "ota_jobs" {
  name         = "${var.project_name}-ota-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"

  attribute {
    name = "jobId"
    type = "S"
  }
  attribute {
    name = "deviceType"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "deviceType-createdAt-index"
    hash_key        = "deviceType"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  tags = { Project = var.project_name }
}

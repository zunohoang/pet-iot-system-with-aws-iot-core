# DynamoDB - User/Device Mapping table
resource "aws_dynamodb_table" "user_device_mapping" {
  name         = "${var.project_name}-user-device"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }
}

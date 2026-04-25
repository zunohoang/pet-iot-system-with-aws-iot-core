# Cognito User Pool + App Client + Identity Pool for IoT WebSocket auth

resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-user-pool"

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_uppercase = true
    require_symbols   = false
  }

  auto_verified_attributes = ["email"]

  schema {
    attribute_data_type = "String"
    name                = "email"
    required            = true
    mutable             = true
  }
}

resource "aws_cognito_user_pool_client" "mobile" {
  name         = "${var.project_name}-mobile-client"
  user_pool_id = aws_cognito_user_pool.main.id

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH"
  ]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
}

# Cognito Identity Pool — issues temporary AWS credentials to the Expo app
# so it can sign MQTT WebSocket connections with SigV4
resource "aws_cognito_identity_pool" "main" {
  identity_pool_name               = "${var.project_name}-identity-pool"
  allow_unauthenticated_identities = false

  cognito_identity_providers {
    client_id               = aws_cognito_user_pool_client.mobile.id
    provider_name           = aws_cognito_user_pool.main.endpoint
    server_side_token_check = false
  }
}

# IAM role for authenticated Cognito users — allows MQTT WebSocket + API calls
resource "aws_iam_role" "cognito_authenticated" {
  name = "${var.project_name}-cognito-authenticated"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "cognito-identity.amazonaws.com" }
      Condition = {
        StringEquals = {
          "cognito-identity.amazonaws.com:aud" = aws_cognito_identity_pool.main.id
        }
        "ForAnyValue:StringLike" = {
          "cognito-identity.amazonaws.com:amr" = "authenticated"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "cognito_authenticated" {
  name = "${var.project_name}-cognito-authenticated-policy"
  role = aws_iam_role.cognito_authenticated.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "IoTMQTTWebSocketConnect"
        Effect = "Allow"
        Action = "iot:Connect"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:client/*"
        ]
      },
      {
        Sid    = "IoTMQTTWebSocketSubscribe"
        Effect = "Allow"
        Action = "iot:Subscribe"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topicfilter/devices/*/status",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topicfilter/devices/*/telemetry",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topicfilter/$aws/things/*/shadow/get/accepted",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topicfilter/$aws/things/*/shadow/get/rejected",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topicfilter/$aws/things/*/shadow/update/accepted",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topicfilter/$aws/things/*/shadow/update/rejected"
        ]
      },
      {
        Sid    = "IoTMQTTWebSocketReceive"
        Effect = "Allow"
        Action = "iot:Receive"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/devices/*/status",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/devices/*/telemetry",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/$aws/things/*/shadow/get/accepted",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/$aws/things/*/shadow/get/rejected",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/$aws/things/*/shadow/update/accepted",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/$aws/things/*/shadow/update/rejected"
        ]
      },
      {
        Sid    = "IoTMQTTWebSocketPublish"
        Effect = "Allow"
        Action = "iot:Publish"
        Resource = [
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/$aws/things/*/shadow/*",
          "arn:aws:iot:${var.aws_region}:${var.aws_account_id}:topic/devices/*"
        ]
      },
      {
        Sid      = "IoTDescribeEndpoint"
        Effect   = "Allow"
        Action   = "iot:DescribeEndpoint"
        Resource = "*"
      },
      {
        Sid      = "IoTAttachPrincipalPolicy"
        Effect   = "Allow"
        Action   = "iot:AttachPrincipalPolicy"
        Resource = "*"
      }
    ]
  })
}

resource "aws_cognito_identity_pool_roles_attachment" "main" {
  identity_pool_id = aws_cognito_identity_pool.main.id

  roles = {
    "authenticated" = aws_iam_role.cognito_authenticated.arn
  }
}

# AWS IoT Policy for Mobile Users (Cognito Identities)
# Because AWS IoT ignores IAM policies for MQTT operations when using Cognito Identities,
# this IoT policy MUST be attached to the Cognito Identity ID to allow connections.
resource "aws_iot_policy" "mobile_user" {
  name = "${var.project_name}-mobile-user-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = [
          "iot:Connect",
          "iot:Subscribe",
          "iot:Publish",
          "iot:Receive"
        ]
        Resource = ["*"]
      }
    ]
  })
}

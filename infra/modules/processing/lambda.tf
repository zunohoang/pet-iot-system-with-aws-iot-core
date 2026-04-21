# Lambda functions: API, IoT Processor, OTA Manager, Provisioning Hook, Scene Engine

# ── Shared IAM execution role ─────────────────────────────────────────────────
resource "aws_iam_role" "lambda_exec" {
  name = "${var.project_name}-lambda-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_permissions" {
  name = "${var.project_name}-lambda-permissions"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDB"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"
        ]
        Resource = [
          var.dynamodb_devices_table_arn,
          "${var.dynamodb_devices_table_arn}/index/*",
          var.dynamodb_claims_table_arn,
          "${var.dynamodb_claims_table_arn}/index/*",
          var.dynamodb_scenes_table_arn,
          "${var.dynamodb_scenes_table_arn}/index/*",
          var.dynamodb_ota_jobs_table_arn,
          "${var.dynamodb_ota_jobs_table_arn}/index/*"
        ]
      },
      {
        Sid      = "SNS"
        Effect   = "Allow"
        Action   = "sns:Publish"
        Resource = var.sns_topic_arn
      },
      {
        Sid    = "IoTCore"
        Effect = "Allow"
        Action = [
          "iot:UpdateThingShadow", "iot:GetThingShadow",
          "iot:CreateJob", "iot:DescribeJob", "iot:UpdateJob",
          "iot:Publish"
        ]
        Resource = "*"
      },
      {
        Sid    = "S3Firmware"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [
          var.firmware_bucket_arn,
          "${var.firmware_bucket_arn}/*"
        ]
      },
      {
        Sid      = "Timestream"
        Effect   = "Allow"
        Action   = ["timestream:WriteRecords", "timestream:DescribeEndpoints", "timestream:Select"]
        Resource = "*"
      }
    ]
  })
}

# ── Archive Lambda source files ───────────────────────────────────────────────
data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.root}/../backend/functions/api/handler.js"
  output_path = "${path.module}/zips/api.zip"
}

data "archive_file" "iot_processor" {
  type        = "zip"
  source_file = "${path.root}/../backend/functions/iot-processor/handler.js"
  output_path = "${path.module}/zips/iot-processor.zip"
}

data "archive_file" "ota_manager" {
  type        = "zip"
  source_file = "${path.root}/../backend/functions/ota-manager/handler.js"
  output_path = "${path.module}/zips/ota-manager.zip"
}

data "archive_file" "provisioning_hook" {
  type        = "zip"
  source_file = "${path.root}/../backend/functions/provisioning-hook/handler.js"
  output_path = "${path.module}/zips/provisioning-hook.zip"
}

data "archive_file" "scene_engine" {
  type        = "zip"
  source_file = "${path.root}/../backend/functions/scene-engine/handler.js"
  output_path = "${path.module}/zips/scene-engine.zip"
}

# ── Common environment variables shared by all Lambdas ────────────────────────
locals {
  common_env = {
    PROJECT_NAME             = var.project_name
    AWS_REGION_NAME          = var.aws_region
    DYNAMODB_DEVICES_TABLE   = var.dynamodb_devices_table_name
    DYNAMODB_CLAIMS_TABLE    = var.dynamodb_claims_table_name
    DYNAMODB_SCENES_TABLE    = var.dynamodb_scenes_table_name
    DYNAMODB_OTA_JOBS_TABLE  = var.dynamodb_ota_jobs_table_name
    FIRMWARE_BUCKET          = var.firmware_bucket_name
    SNS_ALERT_TOPIC_ARN      = var.sns_topic_arn
    TIMESTREAM_DATABASE      = var.timestream_database_name
    TIMESTREAM_TABLE         = var.timestream_table_name
  }
}

# ── Lambda: Backend API ───────────────────────────────────────────────────────
resource "aws_lambda_function" "api" {
  function_name    = "${var.project_name}-api"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.lambda_exec.arn
  timeout          = 30

  environment { variables = local.common_env }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 14
}

# ── Lambda: IoT Processor ─────────────────────────────────────────────────────
resource "aws_lambda_function" "iot_processor" {
  function_name    = "${var.project_name}-iot-processor"
  filename         = data.archive_file.iot_processor.output_path
  source_code_hash = data.archive_file.iot_processor.output_base64sha256
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.lambda_exec.arn
  timeout          = 30

  environment { variables = local.common_env }
}

resource "aws_cloudwatch_log_group" "iot_processor" {
  name              = "/aws/lambda/${aws_lambda_function.iot_processor.function_name}"
  retention_in_days = 14
}

# ── Lambda: OTA Manager ───────────────────────────────────────────────────────
resource "aws_lambda_function" "ota_manager" {
  function_name    = "${var.project_name}-ota-manager"
  filename         = data.archive_file.ota_manager.output_path
  source_code_hash = data.archive_file.ota_manager.output_base64sha256
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.lambda_exec.arn
  timeout          = 60

  environment { variables = local.common_env }
}

resource "aws_cloudwatch_log_group" "ota_manager" {
  name              = "/aws/lambda/${aws_lambda_function.ota_manager.function_name}"
  retention_in_days = 14
}

# ── Lambda: Fleet Provisioning Pre-Hook ───────────────────────────────────────
resource "aws_lambda_function" "provisioning_hook" {
  function_name    = "${var.project_name}-provisioning-hook"
  filename         = data.archive_file.provisioning_hook.output_path
  source_code_hash = data.archive_file.provisioning_hook.output_base64sha256
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.lambda_exec.arn
  timeout          = 10

  environment { variables = local.common_env }
}

resource "aws_cloudwatch_log_group" "provisioning_hook" {
  name              = "/aws/lambda/${aws_lambda_function.provisioning_hook.function_name}"
  retention_in_days = 14
}

# ── Lambda: Scene Engine ──────────────────────────────────────────────────────
resource "aws_lambda_function" "scene_engine" {
  function_name    = "${var.project_name}-scene-engine"
  filename         = data.archive_file.scene_engine.output_path
  source_code_hash = data.archive_file.scene_engine.output_base64sha256
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  role             = aws_iam_role.lambda_exec.arn
  timeout          = 30

  environment { variables = local.common_env }
}

resource "aws_cloudwatch_log_group" "scene_engine" {
  name              = "/aws/lambda/${aws_lambda_function.scene_engine.function_name}"
  retention_in_days = 14
}

# ── EventBridge: nightly schedule → Scene Engine ─────────────────────────────
resource "aws_cloudwatch_event_rule" "nightly_scene" {
  name                = "${var.project_name}-nightly-scene"
  description         = "Trigger scene engine every night at 22:00 UTC+7 (15:00 UTC)"
  schedule_expression = "cron(0 15 * * ? *)"
}

resource "aws_cloudwatch_event_target" "nightly_scene" {
  rule      = aws_cloudwatch_event_rule.nightly_scene.name
  target_id = "SceneEngine"
  arn       = aws_lambda_function.scene_engine.arn

  input = jsonencode({
    source = "eventbridge-scheduler"
    triggerType = "schedule"
    scheduleName = "NightMode"
  })
}

resource "aws_lambda_permission" "allow_eventbridge_scene" {
  statement_id  = "AllowEventBridgeInvokeSceneEngine"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scene_engine.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.nightly_scene.arn
}

# ── API Gateway REST API ──────────────────────────────────────────────────────
resource "aws_api_gateway_rest_api" "main" {
  name        = "${var.project_name}-api"
  description = "IoT Smart Home REST API"
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_authorizer" "cognito" {
  name          = "CognitoAuthorizer"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  type          = "COGNITO_USER_POOLS"
  provider_arns = [var.cognito_user_pool_arn]
}

resource "aws_api_gateway_integration" "proxy" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.api.invoke_arn
}

resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  stage_name  = "v1"

  depends_on = [aws_api_gateway_integration.proxy]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lambda_permission" "apigw_invoke_api" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# IoT Core: Policies, Topic Rules, IAM roles for Rules Engine

# ── IAM: IoT Rules execution role ────────────────────────────────────────────
resource "aws_iam_role" "iot_rules" {
  name = "${var.project_name}-iot-rules-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "iot.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "iot_rules" {
  name = "${var.project_name}-iot-rules-policy"
  role = aws_iam_role.iot_rules.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "TimestreamWrite"
        Effect   = "Allow"
        Action   = ["timestream:WriteRecords", "timestream:DescribeEndpoints"]
        Resource = "*"
      },
      {
        Sid      = "InvokeLambda"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = "*"
      },
      {
        Sid      = "DynamoDBUpdate"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = "*"
      },
      {
        Sid      = "SNSPublish"
        Effect   = "Allow"
        Action   = "sns:Publish"
        Resource = "*"
      }
    ]
  })
}

# ── IoT Policy: Light Switch Device ─────────────────────────────────────────
resource "aws_iot_policy" "switch_device" {
  name = "${var.project_name}-SwitchDevicePolicy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Connect"
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.aws_region}:*:client/${var.project_name}-switch-*"
      },
      {
        Sid    = "Publish"
        Effect = "Allow"
        Action = "iot:Publish"
        Resource = [
          "arn:aws:iot:${var.aws_region}:*:topic/devices/*/telemetry",
          "arn:aws:iot:${var.aws_region}:*:topic/devices/*/status",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/shadow/update",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/shadow/get",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/jobs/*/update",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/jobs/get"
        ]
      },
      {
        Sid    = "SubscribeReceive"
        Effect = "Allow"
        Action = ["iot:Subscribe", "iot:Receive"]
        Resource = [
          "arn:aws:iot:${var.aws_region}:*:topicfilter/devices/*/control",
          "arn:aws:iot:${var.aws_region}:*:topicfilter/$aws/things/*/shadow/*",
          "arn:aws:iot:${var.aws_region}:*:topicfilter/$aws/things/*/jobs/*",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/shadow/*",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/jobs/*"
        ]
      }
    ]
  })
}

# ── IoT Policy: DHT11 Sensor Device ─────────────────────────────────────────
resource "aws_iot_policy" "sensor_device" {
  name = "${var.project_name}-SensorDevicePolicy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Connect"
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${var.aws_region}:*:client/${var.project_name}-sensor-*"
      },
      {
        Sid    = "Publish"
        Effect = "Allow"
        Action = "iot:Publish"
        Resource = [
          "arn:aws:iot:${var.aws_region}:*:topic/devices/*/telemetry",
          "arn:aws:iot:${var.aws_region}:*:topic/devices/*/status",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/shadow/update",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/shadow/get",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/jobs/*/update",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/jobs/get"
        ]
      },
      {
        Sid    = "SubscribeReceive"
        Effect = "Allow"
        Action = ["iot:Subscribe", "iot:Receive"]
        Resource = [
          "arn:aws:iot:${var.aws_region}:*:topicfilter/$aws/things/*/shadow/*",
          "arn:aws:iot:${var.aws_region}:*:topicfilter/$aws/things/*/jobs/*",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/shadow/*",
          "arn:aws:iot:${var.aws_region}:*:topic/$aws/things/*/jobs/*"
        ]
      }
    ]
  })
}

# ── IoT Thing Types ───────────────────────────────────────────────────────────
resource "aws_iot_thing_type" "switch" {
  name = "${var.project_name}-LightSwitch"

  properties {
    description       = "ESP32 Light Switch device with relay control"
    searchable_attributes = ["deviceType", "location", "firmwareVersion"]
  }
}

resource "aws_iot_thing_type" "sensor" {
  name = "${var.project_name}-DHT11Sensor"

  properties {
    description       = "ESP32 DHT11 Temperature and Humidity Sensor"
    searchable_attributes = ["deviceType", "location", "firmwareVersion"]
  }
}

# ── IoT Thing Groups ─────────────────────────────────────────────────────────
resource "aws_iot_thing_group" "switches" {
  name = "${var.project_name}-switches"

  properties {
    description = "All light switch devices"
  }
}

resource "aws_iot_thing_group" "sensors" {
  name = "${var.project_name}-sensors"

  properties {
    description = "All DHT11 sensor devices"
  }
}

# ── Topic Rule: Telemetry → Timestream (direct, low latency) ─────────────────
resource "aws_iot_topic_rule" "store_telemetry" {
  name        = "${replace(var.project_name, "-", "_")}_store_telemetry"
  description = "Write DHT11 telemetry directly to Timestream"
  enabled     = true
  sql         = "SELECT temperature, humidity, topic(2) as deviceId FROM 'devices/+/telemetry'"
  sql_version = "2016-03-23"

  timestream {
    database_name = var.timestream_database_name
    table_name    = var.timestream_table_name
    role_arn      = aws_iam_role.iot_rules.arn

    dimension {
      name  = "deviceId"
      value = "$${deviceId}"
    }
  }

  error_action {
    cloudwatch_logs {
      log_group_name = "/iot/${var.project_name}/rule-errors"
      role_arn       = aws_iam_role.iot_rules.arn
    }
  }
}

# ── Topic Rule: High Temp/Humidity alert → Lambda IoT Processor ──────────────
resource "aws_iot_topic_rule" "high_temp_alert" {
  name        = "${replace(var.project_name, "-", "_")}_high_temp_alert"
  description = "Invoke IoT Processor Lambda when temperature > 35C or humidity > 80%"
  enabled     = true
  sql         = "SELECT *, topic(2) as deviceId FROM 'devices/+/telemetry' WHERE temperature > 35 OR humidity > 80"
  sql_version = "2016-03-23"

  lambda {
    function_arn = var.iot_processor_lambda_arn
  }

  error_action {
    cloudwatch_logs {
      log_group_name = "/iot/${var.project_name}/rule-errors"
      role_arn       = aws_iam_role.iot_rules.arn
    }
  }
}

resource "aws_lambda_permission" "iot_invoke_processor" {
  statement_id  = "AllowIoTInvokeIoTProcessor"
  action        = "lambda:InvokeFunction"
  function_name = var.iot_processor_lambda_arn
  principal     = "iot.amazonaws.com"
  source_arn    = aws_iot_topic_rule.high_temp_alert.arn
}

# ── Topic Rule: All telemetry → Lambda IoT Processor (store + process) ───────
resource "aws_iot_topic_rule" "process_all_telemetry" {
  name        = "${replace(var.project_name, "-", "_")}_process_telemetry"
  description = "Forward all telemetry to IoT Processor for storage and analysis"
  enabled     = true
  sql         = "SELECT *, topic(2) as deviceId FROM 'devices/+/telemetry'"
  sql_version = "2016-03-23"

  lambda {
    function_arn = var.iot_processor_lambda_arn
  }

  error_action {
    cloudwatch_logs {
      log_group_name = "/iot/${var.project_name}/rule-errors"
      role_arn       = aws_iam_role.iot_rules.arn
    }
  }
}

resource "aws_lambda_permission" "iot_invoke_processor_all" {
  statement_id  = "AllowIoTInvokeIoTProcessorAll"
  action        = "lambda:InvokeFunction"
  function_name = var.iot_processor_lambda_arn
  principal     = "iot.amazonaws.com"
  source_arn    = aws_iot_topic_rule.process_all_telemetry.arn
}

# ── Topic Rule: Device status → DynamoDB ─────────────────────────────────────
resource "aws_iot_topic_rule" "device_status" {
  name        = "${replace(var.project_name, "-", "_")}_device_status"
  description = "Upsert device online/offline status into DynamoDB"
  enabled     = true
  sql         = "SELECT *, topic(2) as deviceId, timestamp() as lastSeen FROM 'devices/+/status'"
  sql_version = "2016-03-23"

  dynamodbv2 {
    role_arn = aws_iam_role.iot_rules.arn
    put_item {
      table_name = var.dynamodb_devices_table_name
    }
  }

  error_action {
    cloudwatch_logs {
      log_group_name = "/iot/${var.project_name}/rule-errors"
      role_arn       = aws_iam_role.iot_rules.arn
    }
  }
}

# ── CloudWatch Log Group for Rule errors ─────────────────────────────────────
resource "aws_cloudwatch_log_group" "iot_rule_errors" {
  name              = "/iot/${var.project_name}/rule-errors"
  retention_in_days = 14
}

resource "aws_iam_role_policy_attachment" "iot_rules_cloudwatch" {
  role       = aws_iam_role.iot_rules.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
}

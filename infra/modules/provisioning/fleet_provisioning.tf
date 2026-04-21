# Fleet Provisioning Templates + IAM role for IoT to invoke Lambda hook

# ── IAM: Fleet Provisioning role ─────────────────────────────────────────────
resource "aws_iam_role" "fleet_provisioning" {
  name = "${var.project_name}-fleet-provisioning-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "iot.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "fleet_provisioning" {
  role       = aws_iam_role.fleet_provisioning.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSIoTThingsRegistration"
}

# ── Lambda permission: allow IoT to invoke the PreProvisioningHook ────────────
resource "aws_lambda_permission" "allow_iot_provisioning_hook" {
  statement_id  = "AllowIoTInvokeProvisioningHook"
  action        = "lambda:InvokeFunction"
  function_name = var.provisioning_hook_lambda_arn
  principal     = "iot.amazonaws.com"
}

# ── Fleet Provisioning Template: Light Switch ─────────────────────────────────
resource "aws_iot_provisioning_template" "switch" {
  name                  = "${var.project_name}-SwitchTemplate"
  description           = "Fleet provisioning template for Light Switch (ESP32 + Relay)"
  provisioning_role_arn = aws_iam_role.fleet_provisioning.arn
  enabled               = true

  pre_provisioning_hook {
    target_arn = var.provisioning_hook_lambda_arn
  }

  template_body = jsonencode({
    Parameters = {
      SerialNumber = { Type = "String" }
      DeviceType   = { Type = "String" }
      Location     = { Type = "String", Default = "unknown" }
      AWS = {
        Type = "String"
        Default = {
          ThingName = {
            "Fn::Join" = ["", ["switch-", { Ref = "SerialNumber" }]]
          }
        }
      }
    }
    Resources = {
      thing = {
        Type = "AWS::IoT::Thing"
        Properties = {
          ThingName = { "Fn::Join" = ["", ["switch-", { Ref = "SerialNumber" }]] }
          ThingTypeName = var.switch_thing_type
          AttributePayload = {
            deviceType      = { Ref = "DeviceType" }
            serialNumber    = { Ref = "SerialNumber" }
            location        = { Ref = "Location" }
            firmwareVersion = "1.0.0"
          }
          ThingGroups = [var.switches_group_name]
        }
        OverrideSettings = {
          AttributePayload = "MERGE"
          ThingTypeName    = "REPLACE"
          ThingGroups      = "DO_NOTHING"
        }
      }
      certificate = {
        Type = "AWS::IoT::Certificate"
        Properties = {
          CertificateId = { Ref = "AWS::IoT::Certificate::Id" }
          Status        = "Active"
        }
      }
      policy = {
        Type = "AWS::IoT::Policy"
        Properties = {
          PolicyName = "${var.project_name}-SwitchDevicePolicy"
        }
      }
    }
  })
}

# ── Fleet Provisioning Template: DHT11 Sensor ────────────────────────────────
resource "aws_iot_provisioning_template" "sensor" {
  name                  = "${var.project_name}-SensorTemplate"
  description           = "Fleet provisioning template for DHT11 Sensor (ESP32)"
  provisioning_role_arn = aws_iam_role.fleet_provisioning.arn
  enabled               = true

  pre_provisioning_hook {
    target_arn = var.provisioning_hook_lambda_arn
  }

  template_body = jsonencode({
    Parameters = {
      SerialNumber = { Type = "String" }
      DeviceType   = { Type = "String" }
      Location     = { Type = "String", Default = "unknown" }
    }
    Resources = {
      thing = {
        Type = "AWS::IoT::Thing"
        Properties = {
          ThingName = { "Fn::Join" = ["", ["sensor-", { Ref = "SerialNumber" }]] }
          ThingTypeName = var.sensor_thing_type
          AttributePayload = {
            deviceType      = { Ref = "DeviceType" }
            serialNumber    = { Ref = "SerialNumber" }
            location        = { Ref = "Location" }
            firmwareVersion = "1.0.0"
          }
          ThingGroups = [var.sensors_group_name]
        }
        OverrideSettings = {
          AttributePayload = "MERGE"
          ThingTypeName    = "REPLACE"
          ThingGroups      = "DO_NOTHING"
        }
      }
      certificate = {
        Type = "AWS::IoT::Certificate"
        Properties = {
          CertificateId = { Ref = "AWS::IoT::Certificate::Id" }
          Status        = "Active"
        }
      }
      policy = {
        Type = "AWS::IoT::Policy"
        Properties = {
          PolicyName = "${var.project_name}-SensorDevicePolicy"
        }
      }
    }
  })
}

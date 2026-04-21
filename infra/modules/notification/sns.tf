# SNS - Send alerts/notifications from IoT Processor Lambda
resource "aws_sns_topic" "iot_alerts" {
  name = "${var.project_name}-iot-alerts"
}

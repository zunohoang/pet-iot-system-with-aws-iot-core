# SNS Topic for IoT alerts and notifications

resource "aws_sns_topic" "iot_alerts" {
  name = "${var.project_name}-iot-alerts"
}

resource "aws_sns_topic_subscription" "email_alert" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.iot_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

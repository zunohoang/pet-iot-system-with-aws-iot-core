# Timestream - Telemetry Data storage
resource "aws_timestreamwrite_database" "telemetry" {
  database_name = "${var.project_name}-telemetry"
}

# Timestream Database + Telemetry Table

resource "aws_timestreamwrite_database" "telemetry" {
  database_name = "${var.project_name}-telemetry"

  tags = { Project = var.project_name }
}

resource "aws_timestreamwrite_table" "telemetry" {
  database_name = aws_timestreamwrite_database.telemetry.database_name
  table_name    = "device-telemetry"

  retention_properties {
    magnetic_store_retention_period_in_days = 365
    memory_store_retention_period_in_hours  = 24
  }

  magnetic_store_write_properties {
    enable_magnetic_store_writes = true
  }

  tags = { Project = var.project_name }
}

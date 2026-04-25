# Timestream for InfluxDB — cheapest single-AZ configuration
# Region: ap-southeast-1 (Singapore) — InfluxDB is available here
# LiveAnalytics is NOT available in Singapore and is closed to new customers.

resource "aws_timestreaminfluxdb_db_instance" "main" {
  name = "${var.project_name}-influxdb"

  # ── Cheapest instance class ────────────────────────────────────────────
  db_instance_type  = "db.influx.medium"   # 2 vCPU, 16 GB — smallest available
  db_storage_type   = "InfluxIOIncludedT1" # 3000 IOPS, 125 MB/s — cheapest tier
  allocated_storage = 20                   # 20 GiB minimum

  # ── Single-AZ: cheaper than Multi-AZ ──────────────────────────────────
  deployment_type = "SINGLE_AZ"

  # ── Auth & org setup ──────────────────────────────────────────────────
  username     = "admin"
  password     = var.influxdb_admin_password
  organization = var.project_name
  bucket       = "telemetry"

  # ── Networking ────────────────────────────────────────────────────────
  # publicly_accessible = true lets serverless Lambda connect without VPC config
  publicly_accessible    = true
  vpc_subnet_ids         = data.aws_subnets.default.ids
  vpc_security_group_ids = [aws_security_group.influxdb.id]

  tags = { Project = var.project_name }
}

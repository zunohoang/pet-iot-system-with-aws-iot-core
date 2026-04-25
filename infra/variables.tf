variable "aws_region" {
  default = "ap-southeast-1"
}

variable "project_name" {
  default = "iot-smarthome"
}

variable "alert_email" {
  description = "Email address to receive IoT alerts via SNS"
  type        = string
  default     = "nguyenvanhoang2005nt@gmail.com"
}

variable "influxdb_admin_password" {
  description = "Admin password for Timestream for InfluxDB. Set in terraform.tfvars (never commit)."
  type        = string
  sensitive   = true
}

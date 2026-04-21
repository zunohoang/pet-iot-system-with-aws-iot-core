variable "aws_region" {
  default = "ap-southeast-1"
}

variable "project_name" {
  default = "iot-smarthome"
}

variable "alert_email" {
  description = "Email address to receive IoT alerts via SNS"
  type        = string
  default     = ""
}

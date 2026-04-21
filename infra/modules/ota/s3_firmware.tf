# S3 Bucket - Firmware Storage for OTA updates
resource "aws_s3_bucket" "firmware" {
  bucket = "${var.project_name}-firmware-storage"
}

output "firmware_bucket_name" {
  value = aws_s3_bucket.firmware.bucket
}

output "firmware_bucket_arn" {
  value = aws_s3_bucket.firmware.arn
}

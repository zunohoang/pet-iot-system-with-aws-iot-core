output "claim_certificate_id" {
  value = aws_iot_certificate.claim.id
}

output "claim_certificate_arn" {
  value = aws_iot_certificate.claim.arn
}

output "claim_certificate_pem" {
  value     = aws_iot_certificate.claim.certificate_pem
  sensitive = true
}

output "claim_private_key" {
  value     = aws_iot_certificate.claim.private_key
  sensitive = true
}

output "switch_template_name" {
  value = aws_iot_provisioning_template.switch.name
}

output "sensor_template_name" {
  value = aws_iot_provisioning_template.sensor.name
}

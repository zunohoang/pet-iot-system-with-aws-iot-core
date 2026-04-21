output "switch_policy_arn" {
  value = aws_iot_policy.switch_device.arn
}

output "sensor_policy_arn" {
  value = aws_iot_policy.sensor_device.arn
}

output "switch_thing_type_name" {
  value = aws_iot_thing_type.switch.name
}

output "sensor_thing_type_name" {
  value = aws_iot_thing_type.sensor.name
}

output "switches_group_name" {
  value = aws_iot_thing_group.switches.name
}

output "sensors_group_name" {
  value = aws_iot_thing_group.sensors.name
}

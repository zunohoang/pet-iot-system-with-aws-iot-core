output "api_lambda_arn" {
  value = aws_lambda_function.api.arn
}

output "iot_processor_lambda_arn" {
  value = aws_lambda_function.iot_processor.arn
}

output "ota_manager_lambda_arn" {
  value = aws_lambda_function.ota_manager.arn
}

output "provisioning_hook_lambda_arn" {
  value = aws_lambda_function.provisioning_hook.arn
}

output "scene_engine_lambda_arn" {
  value = aws_lambda_function.scene_engine.arn
}

output "api_gateway_url" {
  value = "${aws_api_gateway_deployment.main.invoke_url}"
}

output "api_gateway_arn" {
  value = aws_api_gateway_rest_api.main.execution_arn
}

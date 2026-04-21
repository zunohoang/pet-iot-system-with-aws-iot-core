output "user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.mobile.id
}

output "identity_pool_id" {
  value = aws_cognito_identity_pool.main.id
}

output "user_pool_arn" {
  value = aws_cognito_user_pool.main.arn
}

# Cognito User Pool for Web/Mobile App authentication
resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-user-pool"
}

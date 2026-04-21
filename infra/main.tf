# AWS Infrastructure - Terraform
# Provisions: Cognito, API Gateway, Lambda, IoT Core,
#             DynamoDB, Timestream, SNS, S3 (firmware), IoT Jobs

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

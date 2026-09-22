# =============================================================================
# Bootstrap: el bucket donde vive el estado de Terraform.
#
# Es el único módulo con estado local, porque no puede guardar su estado en un
# bucket que él mismo está creando. Se aplica una vez por cuenta y no se vuelve
# a tocar. Si el `terraform.tfstate` local se pierde, no pasa nada grave: es un
# solo recurso y se recupera con
#
#   terraform import aws_s3_bucket.state acr-consent-tfstate-<cuenta>
#
#   terraform -chdir=infra/bootstrap init
#   terraform -chdir=infra/bootstrap apply
#
# El nombre es determinista (cuenta de AWS incluida) para que platform/ y api/
# puedan calcularlo sin que nadie tenga que copiarlo a mano.
#
# Sin tabla de DynamoDB para el bloqueo: desde Terraform 1.10 el backend de S3
# bloquea con un archivo `.tflock` junto al estado (`use_lockfile = true`).
# =============================================================================

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket = "acr-consent-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket

  # El estado contiene identificadores de todo lo desplegado y, si se activa,
  # el secreto del app client. Que un `destroy` no se lo lleve por delante.
  force_destroy = false

  tags = {
    Application = "consentimiento-informado"
    Purpose     = "terraform-state"
  }
}

# Cada apply guarda una versión nueva: es el historial al que se vuelve cuando
# un apply sale mal.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket" {
  description = "Pásalo a `terraform init -backend-config=\"bucket=...\"` en platform/ y api/."
  value       = aws_s3_bucket.state.id
}

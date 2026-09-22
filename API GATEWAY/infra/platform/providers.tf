# =============================================================================
# platform/ — lo que guarda datos y casi nunca cambia.
#
#   KMS · DynamoDB · S3 · Cognito
#
# Estado propio, separado del de api/. Desplegar el API no puede tocar nada de
# aquí, y esto se aplica a mano, deliberadamente, cuando cambia — que debería
# ser casi nunca. Todo lo de este módulo tiene protección contra borrado.
#
# Primera vez:
#
#   terraform -chdir=infra/platform init \
#     -backend-config="bucket=acr-consent-tfstate-<cuenta>" \
#     -backend-config="region=us-east-1"
#   terraform -chdir=infra/platform apply
#
# El bucket lo crea infra/bootstrap. `node scripts/deploy.mjs --platform` hace
# estos dos pasos con el nombre ya calculado.
# =============================================================================

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # `bucket` y `region` llegan por -backend-config: un bloque backend no admite
  # variables ni data sources, y el nombre lleva el id de cuenta.
  backend "s3" {
    key          = "platform/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.project_tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  # Vacío = sin prefijo (producción). "dev" → "dev-consent_audit_logs", etc.
  # Permite un segundo entorno en la misma cuenta sin que los nombres choquen.
  name_prefix = var.environment == "" ? "" : "${var.environment}-"
}

# =============================================================================
# api/ — lo que cambia con cada despliegue.
#
#   ECR · Lambda · API Gateway · IAM
#
# Estado propio. Lee lo que necesita de platform/ (tabla, bucket, Cognito,
# clave KMS) a través de su estado remoto, y no puede modificar nada de eso:
# un apply aquí, por mal que salga, no alcanza a los datos.
#
# Lo aplica scripts/deploy.mjs en cada push. A mano:
#
#   terraform -chdir=infra/api init \
#     -backend-config="bucket=acr-consent-tfstate-<cuenta>" \
#     -backend-config="region=us-east-1"
#   terraform -chdir=infra/api apply
#
# platform/ tiene que estar aplicado antes: sin su estado, el data source de
# abajo no tiene de dónde leer y el plan falla en el primer paso.
# =============================================================================

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  backend "s3" {
    key          = "api/terraform.tfstate"
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

# Mismo bucket que el backend, mismo nombre determinista que crea bootstrap/.
# Aquí sí puede calcularse porque un data source admite expresiones; el bloque
# backend de arriba no.
data "terraform_remote_state" "platform" {
  backend = "s3"

  config = {
    bucket = "acr-consent-tfstate-${data.aws_caller_identity.current.account_id}"
    key    = "platform/terraform.tfstate"
    region = var.aws_region
  }
}

locals {
  # Atajo: local.platform.evidence_bucket_arn, local.platform.pdf_bucket, etc.
  # Los nombres son los outputs de platform/.
  platform = data.terraform_remote_state.platform.outputs

  name_prefix = local.platform.name_prefix
}

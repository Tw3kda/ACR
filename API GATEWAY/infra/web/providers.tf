# =============================================================================
# web/ — hosting de la web de consulta (WEB PDF CHECK/my-app).
#
#   S3 privado · CloudFront (OAC, HTTPS en *.cloudfront.net)
#
# Por qué no "S3 static website": ese endpoint es solo HTTP y público, y la
# web envía contraseñas y tokens. CloudFront da HTTPS gratis sin dominio propio
# y el bucket queda cerrado: solo esta distribución puede leerlo.
#
# Estado propio. Solo lee el prefijo de nombres de platform/. La URL del API
# entra en el build de Vite (VITE_API_URL), no aquí. El dominio de CloudFront
# que sale de aquí va a platform/terraform.tfvars (cors_allowed_origins) para
# que el gateway acepte las peticiones del navegador.
#
#   node scripts/deploy.mjs --web          (desde API GATEWAY/)
# =============================================================================

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    key          = "web/terraform.tfstate"
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

data "terraform_remote_state" "platform" {
  backend = "s3"

  config = {
    bucket = "acr-consent-tfstate-${data.aws_caller_identity.current.account_id}"
    key    = "platform/terraform.tfstate"
    region = var.aws_region
  }
}

# Solo para la Content-Security-Policy: a qué API y a qué bucket puede hablar la web.
data "terraform_remote_state" "api" {
  backend = "s3"

  config = {
    bucket = "acr-consent-tfstate-${data.aws_caller_identity.current.account_id}"
    key    = "api/terraform.tfstate"
    region = var.aws_region
  }
}

locals {
  name_prefix = data.terraform_remote_state.platform.outputs.name_prefix
  site_name   = "${local.name_prefix}medical-consent-web"

  # https://abc.execute-api.us-east-1.amazonaws.com/ → https://abc.execute-api.us-east-1.amazonaws.com
  api_origin = trimsuffix(data.terraform_remote_state.api.outputs.api_endpoint, "/")
  # Origen de las URL firmadas del PDF (vista previa en iframe y descarga).
  pdf_origin = "https://${data.terraform_remote_state.platform.outputs.pdf_bucket}.s3.${var.aws_region}.amazonaws.com"
}

variable "aws_region" {
  description = "Debe coincidir con la de platform/: el estado remoto se lee de esa región."
  type        = string
  default     = "us-east-1"
}

variable "project_tags" {
  type = map(string)
  default = {
    Application = "consentimiento-informado"
  }
}

variable "price_class" {
  description = <<-EOT
    Bordes de CloudFront que sirven el sitio. PriceClass_100 (Norteamérica y
    Europa) es el más barato; Colombia se sirve desde Miami con ~50 ms extra,
    irrelevante para un sitio estático pequeño.
  EOT
  type        = string
  default     = "PriceClass_100"
}

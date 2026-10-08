# =============================================================================
# La función del API, desplegada como .zip en el runtime gestionado nodejs22.x.
#
# El código es Node puro (sin binarios nativos), así que no hace falta una
# imagen de contenedor: sin ECR, sin Docker, y despliegues de segundos.
#
#   scripts/deploy.mjs  →  .build/lambda/ (package.json + src + npm ci --omit=dev)
#                       →  terraform apply (archive_file lo comprime y lo sube)
#
# El handler es el mismo de siempre: `src/handlers/api.handler`. La
# configuración llega entera por variables de entorno (outputs.tf).
# =============================================================================

locals {
  # Lo prepara scripts/deploy.mjs antes de cada plan/apply.
  lambda_build_dir = "${path.module}/../../.build/lambda"
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = local.lambda_build_dir
  output_path = "${path.module}/../../.build/lambda.zip"
}

variable "api_reserved_concurrency" {
  description = <<-EOT
    Ejecuciones simultáneas reservadas para el API. Es un techo además de una
    reserva: por encima de esto el gateway responde 429, y un pico —o un bucle
    de reintentos— no puede consumir la concurrencia de toda la cuenta.

    null = sin reserva, a propósito. Una cuenta de AWS recién creada tiene un
    límite de 10 ejecuciones simultáneas en total y Lambda rechaza cualquier
    reserva que deje la cuenta por debajo de su mínimo. Cuando el límite de la
    cuenta esté en 1000 (se pide en Service Quotas → Lambda → Concurrent
    executions; suele concederse solo), poner 20 aquí.
  EOT
  type        = number
  default     = null
}

variable "lambda_log_retention_days" {
  type    = number
  default = 90
}

# -----------------------------------------------------------------------------
# Registro de imágenes — YA NO SE USA (la función es .zip desde 2026-10).
# Se conserva hasta confirmar el despliegue por zip; después se elimina este
# bloque, la lifecycle policy y el output ecr_repository_url.
# -----------------------------------------------------------------------------
resource "aws_ecr_repository" "api" {
  name = "acr-consent-api"

  # Un tag apunta siempre a la misma imagen. Con tags mutables, `terraform
  # apply` no detecta que la imagen cambió detrás del mismo tag y no redespliega.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  # Que un `destroy` no pueda llevarse el historial de imágenes desplegadas.
  force_delete = false
}

# Las imágenes viejas no se borran solas. Diez es suficiente para volver atrás
# y no pagar almacenamiento por lo que ya no corre.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Conservar las últimas 10 imágenes"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# -----------------------------------------------------------------------------
# Roles de ejecución
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "express_app" {
  name               = "${local.name_prefix}medical-consent-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "express_app_logs" {
  role       = aws_iam_role.express_app.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "express_app_api" {
  role       = aws_iam_role.express_app.name
  policy_arn = aws_iam_policy.api.arn
}

resource "aws_iam_role_policy_attachment" "express_app_registration" {
  count = var.expose_register_route ? 1 : 0

  role       = aws_iam_role.express_app.name
  policy_arn = aws_iam_policy.api_registration[0].arn
}

# -----------------------------------------------------------------------------
# API (Express)
# -----------------------------------------------------------------------------
# Declarado a mano para fijar la retención. Si lo crea Lambda solo, los logs
# se guardan para siempre.
resource "aws_cloudwatch_log_group" "express_app" {
  name              = "/aws/lambda/${local.name_prefix}medical-consent-api"
  retention_in_days = var.lambda_log_retention_days
}

resource "aws_lambda_function" "express_app" {
  function_name = "${local.name_prefix}medical-consent-api"
  role          = aws_iam_role.express_app.arn
  package_type  = "Zip"
  runtime       = "nodejs22.x"
  handler       = "src/handlers/api.handler"

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  architectures = ["x86_64"]

  # 10 s es también el timeout de la integración en api_gateway.tf: si esto
  # fuera mayor, el gateway cortaría antes y la función seguiría corriendo sin
  # que nadie recibiera la respuesta.
  timeout     = 10
  memory_size = 512

  reserved_concurrent_executions = var.api_reserved_concurrency

  environment {
    variables = local.lambda_environment
  }

  depends_on = [
    aws_cloudwatch_log_group.express_app,
    aws_iam_role_policy_attachment.express_app_logs,
  ]
}

# -----------------------------------------------------------------------------
# Salidas
# -----------------------------------------------------------------------------
output "ecr_repository_url" {
  description = "Destino del docker push. scripts/deploy.mjs lo lee de aquí."
  value       = aws_ecr_repository.api.repository_url
}

output "lambda_function_names" {
  value = {
    api = aws_lambda_function.express_app.function_name
  }
}

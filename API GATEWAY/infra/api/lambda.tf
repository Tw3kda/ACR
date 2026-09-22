# =============================================================================
# La función del API, desplegada como imagen de contenedor.
#
# El `--target lambda` del Dockerfile parte de `public.ecr.aws/lambda/nodejs:22`
# y copia `src/` entero; el handler que arranca es `src/handlers/api.handler`.
#
# El ciclo de despliegue es:
#
#   docker build --target lambda  →  docker push a ECR  →  terraform apply
#
# `scripts/deploy.mjs` hace los tres pasos y deja el tag de la imagen en
# `infra/api/image.auto.tfvars`, que Terraform carga solo. Así `terraform apply` a
# secas siempre despliega la última imagen subida, y el estado nunca discrepa
# de lo que corre.
#
# Las variables de entorno de la función **pisan** las `ENV` de la imagen. Es
# importante aquí: el Dockerfile deja ALLOW_STUB_IN_PRODUCTION=true y
# TRACE_IO=true para poder probar el handler en local sin AWS detrás, y
# outputs.tf las pone a false. Gana outputs.tf. Sin eso, un despliegue con un
# adaptador mal configurado arrancaría en modo simulado sin quejarse.
# =============================================================================

variable "api_image_tag" {
  description = <<-EOT
    Tag de la imagen en ECR que corre en ambas funciones. Lo escribe
    scripts/deploy.mjs en image.auto.tfvars tras cada push; no hace falta
    pasarlo a mano. Sin valor, `plan` lo pregunta — es lo esperado antes del
    primer despliegue.
  EOT
  type        = string
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
# Registro de imágenes
# -----------------------------------------------------------------------------
# Sin prefijo de entorno a propósito: una imagen no sabe en qué entorno corre
# (toda su configuración llega por variables de la función), así que dev y prod
# comparten repositorio y la misma imagen se promociona de uno a otro.
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

locals {
  image_uri = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
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
  package_type  = "Image"
  image_uri     = local.image_uri

  # Tiene que coincidir con el `--platform` del docker build. Una imagen arm64
  # aquí falla en el arranque con "exec format error" y nada más.
  architectures = ["x86_64"]

  # 10 s es también el timeout de la integración en api_gateway.tf: si esto
  # fuera mayor, el gateway cortaría antes y la función seguiría corriendo sin
  # que nadie recibiera la respuesta.
  timeout     = 10
  memory_size = 512

  reserved_concurrent_executions = var.api_reserved_concurrency

  image_config {
    command = ["src/handlers/api.handler"]
  }

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

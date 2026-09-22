# =============================================================================
# API Gateway HTTP API — configuración final
#
# Expone la Lambda de Express (5 rutas del contrato + health) y el autorizador
# JWT de Cognito.
#
# Lo que referencia:
#   var.aws_region                    variables.tf
#   aws_lambda_function.express_app   lambda.tf
#   local.platform.cognito_*          estado remoto de platform/ (providers.tf)
#
# La concurrencia reservada está en lambda.tf.
#
# Revisión y motivo de cada decisión: docs/REVISION_API_GATEWAY.md
# =============================================================================

variable "expose_register_route" {
  description = <<-EOT
    Publica POST /auth/register. El auto-registro abierto permite crear cuentas
    de personal clínico con sesión inmediata a cualquiera que alcance la URL: lo
    que no está publicado no se puede forzar. La Lambda además lo rechaza con
    403 salvo que REGISTRATION_ENABLED=true.
  EOT
  type        = bool
  default     = false
}

variable "api_log_retention_days" {
  type    = number
  default = 90
}

locals {
  api_name    = "${local.name_prefix}medical-consent-api"
  integracion = "integrations/${aws_apigatewayv2_integration.lambda_express.id}"
}

# -----------------------------------------------------------------------------
# API
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_api" "http_api" {
  name          = local.api_name
  protocol_type = "HTTP"

  # `x-api-key` es imprescindible en la lista: la app lo envía cuando
  # EXPO_PUBLIC_API_KEY está definida, y sin declararlo el preflight falla solo
  # en el navegador — en la tablet funciona, que es el síntoma más confuso.
  #
  # `x-amz-checksum-sha256` no va aquí: viaja en el PUT directo a S3, que no
  # pasa por el gateway. Ese encabezado lo tiene que permitir el bucket.
  cors_configuration {
    allow_origins     = local.platform.cors_allowed_origins
    allow_methods     = ["GET", "POST", "OPTIONS"]
    allow_headers     = ["authorization", "content-type", "x-api-key"]
    expose_headers    = ["x-request-id"]
    allow_credentials = false
    max_age           = 300
  }

  tags = {
    Application = "consentimiento-informado"
  }
}

# -----------------------------------------------------------------------------
# Stage
# -----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.api_name}"
  retention_in_days = var.api_log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true

  # Cuando el autorizador rechaza una petición, la Lambda no llega a ejecutarse:
  # sin estos logs, un 401 no deja rastro en ninguna parte.
  # `authorizer.error` e `integrationErrorMessage` son los dos campos que
  # importan para depurar eso.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId               = "$context.requestId"
      ip                      = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      responseLatency         = "$context.responseLatency"
      integrationStatus       = "$context.integrationStatus"
      integrationErrorMessage = "$context.integrationErrorMessage"
      authorizerError         = "$context.authorizer.error"
      userSub                 = "$context.authorizer.claims.sub"
      userAgent               = "$context.identity.userAgent"
    })
  }

  # Sin esto se hereda la cuota de la cuenta (10.000 rps).
  default_route_settings {
    detailed_metrics_enabled = true
    throttling_rate_limit    = 200
    throttling_burst_limit   = 400
  }

  # Las rutas de /auth/* no llevan autorizador —son las que crean la sesión—, así
  # que este límite es la única barrera contra fuerza bruta desde el gateway:
  # AWS WAF no se puede asociar a un HTTP API v2. Para una clínica sobra; el
  # volumen normal es un login por profesional al empezar la jornada.
  route_settings {
    route_key              = "POST /auth/login"
    throttling_rate_limit  = 5
    throttling_burst_limit = 10
  }

  route_settings {
    route_key              = "POST /auth/refresh"
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }

  dynamic "route_settings" {
    for_each = var.expose_register_route ? [1] : []
    content {
      route_key              = "POST /auth/register"
      throttling_rate_limit  = 1
      throttling_burst_limit = 2
    }
  }

  # API Gateway valida al crear el stage que cada route_key de route_settings
  # exista ya. Sin esto, Terraform crea el stage en paralelo con las rutas y el
  # primer apply falla con "Unable to find Route by key ... within the provided
  # RouteSettings". Las rutas protegidas no hacen falta aquí: no tienen
  # route_settings propios.
  depends_on = [
    aws_apigatewayv2_route.auth_login,
    aws_apigatewayv2_route.auth_refresh,
    aws_apigatewayv2_route.auth_register,
  ]
}

# -----------------------------------------------------------------------------
# Autorizador JWT
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_authorizer" "cognito_jwt" {
  api_id           = aws_apigatewayv2_api.http_api.id
  name             = "cognito-jwt-authorizer"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  # `audience` se compara contra el `aud` del token y, en los access token de
  # Cognito —que llevan `client_id` en vez de `aud`—, contra `client_id`.
  #
  # El tipo de token tiene que coincidir con COGNITO_TOKEN_FOR_APP en la Lambda
  # (`access` por defecto). Si no coincide, TODA ruta protegida devuelve 401 y
  # el síntoma parece un problema de sesión.
  jwt_configuration {
    audience = [local.platform.cognito_client_id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${local.platform.cognito_user_pool_id}"
  }
}

# -----------------------------------------------------------------------------
# Integración
# -----------------------------------------------------------------------------
resource "aws_apigatewayv2_integration" "lambda_express" {
  api_id           = aws_apigatewayv2_api.http_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.express_app.invoke_arn

  # 2.0 es lo que espera el adaptador de la Lambda. Con 1.0 el evento llega con
  # otra forma y fallan todas las rutas.
  payload_format_version = "2.0"

  # Por defecto son 30 s, el máximo. Ninguna de estas rutas debería pasar de un
  # par de segundos.
  timeout_milliseconds = 10000
}

resource "aws_lambda_permission" "apigw_permission" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.express_app.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/${aws_apigatewayv2_stage.default.name}/*/*"
}

# -----------------------------------------------------------------------------
# Rutas
#
# Explícitas y no `ANY /{proxy+}`: un comodín con autorizador JWT deja
# /auth/login detrás del autorizador —haría falta un token para poder obtener un
# token— y la app no podría iniciar sesión nunca.
#
# Además permiten límite de tasa por ruta, dejan por escrito qué está protegido,
# y hacen trivial mover /auth/* a otra Lambda para separar los permisos de IAM.
# -----------------------------------------------------------------------------

# --- Públicas: crean la sesión -----------------------------------------------
resource "aws_apigatewayv2_route" "auth_login" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "POST /auth/login"
  target             = local.integracion
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "auth_refresh" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "POST /auth/refresh"
  target             = local.integracion
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "auth_register" {
  count = var.expose_register_route ? 1 : 0

  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "POST /auth/register"
  target             = local.integracion
  authorization_type = "NONE"
}

# --- Protegidas con Cognito --------------------------------------------------
resource "aws_apigatewayv2_route" "audit_logs" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "POST /audit/logs"
  target             = local.integracion
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "consents" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "POST /consents"
  target             = local.integracion
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# --- Salud -------------------------------------------------------------------
# Pública, pero la Lambda solo publica el detalle de configuración con
# HEALTH_DETAILED=true. En producción responde {"status":"ok"} y nada más.
resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "GET /health"
  target             = local.integracion
  authorization_type = "NONE"
}

# No se define ruta `$default`: una ruta inexistente la rechaza el propio
# gateway con {"message":"Not Found"} sin invocar la Lambda.

# -----------------------------------------------------------------------------
# Salidas
# -----------------------------------------------------------------------------
output "api_endpoint" {
  description = "Valor de EXPO_PUBLIC_API_URL en el .env de la app."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_id" {
  value = aws_apigatewayv2_api.http_api.id
}

output "api_access_log_group" {
  value = aws_cloudwatch_log_group.api_access.name
}

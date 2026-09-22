# =============================================================================
# Variables de entorno del Lambda, ya resueltas.
#
# Los nombres son exactamente los de .env.example, así que esto se puede pasar
# tal cual al bloque `environment` de la función cuando exista:
#
#   environment {
#     variables = local.lambda_environment
#   }
#
# El secreto del app client NO va aquí: si se activa, pásalo por Secrets
# Manager. Una variable de entorno de Lambda se lee desde la consola con solo
# tener permiso de lectura sobre la función.
# =============================================================================

locals {
  lambda_environment = {
    # AWS_REGION no va aquí: Lambda la define sola y rechaza la función si se
    # intenta fijar ("reserved keys ... AWS_REGION"). El código la lee del
    # entorno igual; las *_REGION de cada servicio sí son nuestras.
    NODE_ENV     = "production"
    SERVICE_NAME = "acr-consent-api"

    # Stage $default: sin prefijo de ruta.
    API_STAGE_PREFIX = ""

    # --- S3: registro de auditoría ---
    # Los drivers pasan solos a `aws` en cuanto estos identificadores existen.
    EVIDENCE_BUCKET        = local.platform.evidence_bucket
    EVIDENCE_EVENTS_PREFIX = "events"
    EVIDENCE_INDEX_PREFIX  = "index"

    # --- S3: PDFs ---
    PDF_BUCKET     = local.platform.pdf_bucket
    PDF_KEY_PREFIX = local.platform.pdf_key_prefix
    # Vacío: el bucket cifra por defecto (SSE-S3) y la firma no arrastra
    # cabeceras de cifrado que la app tendría que reenviar exactas.
    PDF_SSE_KMS_KEY_ID = ""

    # --- Cognito ---
    COGNITO_USER_POOL_ID = local.platform.cognito_user_pool_id
    COGNITO_CLIENT_ID    = local.platform.cognito_client_id
    COGNITO_REGION       = var.aws_region
    COGNITO_AUTH_FLOW    = "ADMIN_USER_PASSWORD_AUTH"

    # Tiene que coincidir con lo que valida el autorizador JWT.
    COGNITO_TOKEN_FOR_APP = var.cognito_token_for_app

    # Sin secreto no hace falta SECRET_HASH, así que el refresh no necesita
    # username y no hay sobre que construir.
    COGNITO_REFRESH_USERNAME_MODE = local.platform.cognito_client_has_secret ? "envelope" : "none"

    REGISTRATION_ENABLED = tostring(var.expose_register_route)

    # --- Salud y traza ---
    # Ambas apagadas en producción: /health es pública, y volcar cuerpos
    # completos en CloudWatch es un problema de privacidad, no una ayuda.
    HEALTH_DETAILED = "false"
    TRACE_IO        = "false"

    # Que un despliegue con adaptadores simulados falle en frío.
    ALLOW_STUB_IN_PRODUCTION = "false"
  }
}

output "lambda_environment" {
  description = "Variables de entorno del Lambda, con los nombres de .env.example."
  value       = local.lambda_environment
}

output "app_env" {
  description = "Lo que hay que poner en el .env de la app móvil."
  value = {
    EXPO_PUBLIC_API_URL              = aws_apigatewayv2_stage.default.invoke_url
    EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS = tostring(local.platform.access_token_hours)
    EXPO_PUBLIC_PDF_S3_BUCKET        = local.platform.pdf_bucket
    EXPO_PUBLIC_PDF_S3_PREFIX        = local.platform.pdf_key_prefix
  }
}

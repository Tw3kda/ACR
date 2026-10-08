# =============================================================================
# User pool y app client.
#
# Los nombres de recurso (`pool`, `client`) son los que ya referencia
# api_gateway.tf en el autorizador JWT.
#
# Sin verificación por correo, por decisión del contrato: el usuario se crea y
# se confirma en el mismo POST, y la respuesta trae la sesión ya iniciada
# porque la app inicia sesión de inmediato con el token que recibe. De ahí
# `allow_admin_create_user_only` y la ausencia de `auto_verified_attributes`.
# =============================================================================

resource "aws_cognito_user_pool" "pool" {
  # Cognito es de pago en LocalStack: con var.localstack no se crea.
  count = var.localstack ? 0 : 1

  name = "${local.name_prefix}medical-consent-users"

  # El correo es el identificador. No hay username aparte.
  username_attributes = ["email"]

  # Sin `auto_verified_attributes`: nadie recibe códigos de verificación.
  #
  # Aviso que no es de Terraform y muerde igual: `AdminCreateUser` manda un
  # correo de invitación con contraseña temporal salvo que el Lambda pase
  # `MessageAction: SUPPRESS`. Si no se suprime, el profesional recibe una
  # contraseña que no va a usar nunca.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_uppercase                = true
    require_symbols                  = false
    temporary_password_validity_days = 1
  }

  # Los bloques `schema` son lo que hay que acertar a la primera: añadir un
  # atributo nuevo se puede, pero cambiar o quitar uno existente obliga a
  # recrear el user pool, y ahí se van todos los usuarios con él.
  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 1
      max_length = 128
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  deletion_protection = "ACTIVE"

  tags = {
    Name = "${local.name_prefix}medical-consent-users"
  }
}

resource "aws_cognito_user_pool_client" "client" {
  count = var.localstack ? 0 : 1

  name         = "${local.name_prefix}medical-consent-api"
  user_pool_id = aws_cognito_user_pool.pool[0].id

  # Ver la nota larga en `cognito_client_has_secret` (variables.tf): sin secreto
  # el refresh no necesita SECRET_HASH y desaparece el problema del username.
  generate_secret = var.cognito_client_has_secret

  # ALLOW_REFRESH_TOKEN_AUTH es imprescindible y es lo que más se olvida: sin
  # él el login funciona y `/auth/refresh` empieza a fallar doce horas después,
  # que es cuando ya nadie lo relaciona con este flag.
  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Mismo mensaje para usuario inexistente y contraseña mala. Es lo que hace
  # cumplir sola la regla del contrato de no permitir enumerar cuentas.
  prevent_user_existence_errors = "ENABLED"

  # 12 h de access token: cubre una jornada completa. Tiene que coincidir con
  # EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS en el .env de la app, que es el valor con
  # el que decide cuándo renovar por adelantado. Si la app cree que dura más de
  # lo que dura, el profesional se come un 401 —del que se recupera solo, pero
  # con una petición perdida por medio.
  access_token_validity  = var.access_token_hours
  id_token_validity      = var.access_token_hours
  refresh_token_validity = var.refresh_token_days

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  enable_token_revocation      = true
  supported_identity_providers = ["COGNITO"]
}

# Quién puede usar la web de consulta (WEB PDF CHECK/). La Lambda exige esta
# claim en /audit/search y /consents/*/pdf-download-url (AUTH_READER_GROUP). Un
# profesional de tablet no pertenece al grupo y recibe 403.
#
#   aws cognito-idp admin-add-user-to-group #     --user-pool-id <pool> --username <correo> --group-name auditores
resource "aws_cognito_user_group" "auditores" {
  count = var.localstack ? 0 : 1

  name         = "auditores"
  user_pool_id = aws_cognito_user_pool.pool[0].id
  description  = "Consulta y descarga de consentimientos desde la web"
  precedence   = 10
}

# `one()` devuelve null cuando count = 0 (LocalStack), en vez de romper el plan.
output "cognito_user_pool_id" {
  description = "Valor de COGNITO_USER_POOL_ID. null en LocalStack."
  value       = one(aws_cognito_user_pool.pool[*].id)
}

output "cognito_client_id" {
  description = "Valor de COGNITO_CLIENT_ID. null en LocalStack."
  value       = one(aws_cognito_user_pool_client.client[*].id)
}

output "cognito_client_secret" {
  description = "Valor de COGNITO_CLIENT_SECRET. Vacío si cognito_client_has_secret = false."
  value       = one(aws_cognito_user_pool_client.client[*].client_secret)
  sensitive   = true
}

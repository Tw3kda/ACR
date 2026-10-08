# =============================================================================
# Política de permisos de la función del API.
#
# Lo que NO puede hacer importa tanto como lo que puede: no puede borrar nada
# en ningún sitio, y no toca un bucket fuera de su prefijo. Los recursos a los que apuntan viven en platform/ y llegan por su
# estado remoto (`local.platform.*`). Los roles que las usan están en lambda.tf.
# =============================================================================

data "aws_iam_policy_document" "api" {
  # El registro de auditoría: escribir eventos y punteros (una sola vez por
  # clave; la idempotencia la impone S3 con If-None-Match) y leer el evento
  # existente cuando un reenvío choca con él.
  statement {
    sid     = "AppendEvidence"
    actions = ["s3:PutObject"]

    resources = [
      "${local.platform.evidence_bucket_arn}/events/*",
      "${local.platform.evidence_bucket_arn}/index/*",
      # Registro de accesos de la web de consulta (quién buscó / descargó).
      "${local.platform.evidence_bucket_arn}/access/*",
      # Plantillas de consentimiento y fotos del catálogo (publish-template.mjs).
      "${local.platform.evidence_bucket_arn}/templates/*",
    ]
  }

  statement {
    sid       = "ReadEvidence"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [local.platform.evidence_bucket_arn, "${local.platform.evidence_bucket_arn}/*"]
  }

  # Guardar el PDF (una sola vez) y, si la clave ya existía, leer el checksum
  # del que está para decidir si es el mismo documento.
  statement {
    sid       = "StorePdf"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectAttributes"]
    resources = ["${local.platform.pdf_bucket_arn}/${local.platform.pdf_key_prefix}/*"]
  }

  statement {
    sid       = "AuthLogin"
    actions   = ["cognito-idp:AdminInitiateAuth"]
    resources = [local.platform.cognito_user_pool_arn]
  }
}

# Crear usuarios es un permiso aparte a propósito: si el registro no está
# publicado, este bloque no debería existir en el rol.
data "aws_iam_policy_document" "api_registration" {
  statement {
    sid = "AuthRegister"

    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminSetUserPassword",
    ]

    resources = [local.platform.cognito_user_pool_arn]
  }
}

resource "aws_iam_policy" "api" {
  name        = "${local.name_prefix}medical-consent-api"
  description = "Lambda del API: evidencia, PDFs y login"
  policy      = data.aws_iam_policy_document.api.json
}

resource "aws_iam_policy" "api_registration" {
  count = var.expose_register_route ? 1 : 0

  name        = "${local.name_prefix}medical-consent-api-registration"
  description = "Alta de usuarios. Solo si /auth/register está publicada."
  policy      = data.aws_iam_policy_document.api_registration.json
}

output "iam_policy_arns" {
  description = "Adjuntas a los roles en lambda.tf."
  value = {
    api          = aws_iam_policy.api.arn
    registration = var.expose_register_route ? aws_iam_policy.api_registration[0].arn : null
  }
}

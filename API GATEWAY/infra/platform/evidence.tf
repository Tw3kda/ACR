# =============================================================================
# Bucket de evidencia: el registro de auditoría.
#
#   events/<consent_id>/0001-CONSENT_SIGNED.json     el log que envía la app
#   events/<consent_id>/0002-PDF_VERIFIED.json       lo que comprobó el verificador
#   index/patient|clinic|date/…                       punteros vacíos para listar
#   manifests/<aaaa>/<mm>/<dd>.json                   (futuro) manifiesto diario
#
# Todo lo que entra queda bajo Object Lock durante `evidence_retention_days`, y
# lo aplica el bucket al recibir cada objeto: ningún código puede olvidarse de
# bloquear un evento. Pasado el plazo, una regla de ciclo de vida lo retira —
# es S3 quien actúa, no una persona, así que no pasa por IAM ni por la SCP.
#
# Separado del bucket de PDFs porque la retención por defecto es UNA por
# bucket: los PDFs viven 30 días, la evidencia 365. Dos plazos, dos buckets.
#
# Sin KMS: cifrado SSE-S3. Object Lock no depende del cifrado, y la clave
# gestionada era la única partida de la factura que no era calderilla.
# =============================================================================

locals {
  evidence_bucket_name = "${local.name_prefix}medical-consent-evidence-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "evidence" {
  bucket              = local.evidence_bucket_name
  object_lock_enabled = true
  force_destroy       = false

  tags = {
    Name = local.evidence_bucket_name
  }
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.evidence_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.evidence]
}

# Expira un día después de que venza el bloqueo, que es lo más pronto que S3
# permite borrar. La expiración de la versión vigente deja un marcador; la de
# versiones no vigentes retira los bytes.
resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    id     = "expire-after-retention"
    status = "Enabled"

    filter {}

    expiration {
      days = var.evidence_retention_days + 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.evidence]
}

output "evidence_bucket" {
  description = "Valor de EVIDENCE_BUCKET en el Lambda."
  value       = aws_s3_bucket.evidence.id
}

output "evidence_bucket_arn" {
  value = aws_s3_bucket.evidence.arn
}

# -----------------------------------------------------------------------------
# Política del bucket: solo el servicio añade, y nadie sobreescribe.
#
# Object Lock protege VERSIONES: impide borrar o acortar lo que ya está, pero
# no impide escribir otra versión encima del mismo nombre, que pasaría a ser la
# "actual" y taparía la original. Dos Deny explícitos, que se aplican a todo
# principal IAM de la cuenta, administradores incluidos:
#
#   1. PutObject solo desde el rol del API. El rol vive en infra/api (otro
#      estado); se nombra por ARN, que no necesita existir.
#   2. PutObject solo con `If-None-Match: *`: S3 rechaza cualquier escritura
#      sobre un nombre existente, venga de donde venga. El código ya lo envía
#      siempre (evidence.aws.js); esto lo convierte en regla del bucket.
#
# Lo único que esto no cubre es root, que puede editar la política antes de
# escribir. Eso lo tapa la SCP de infra/org cuando exista la cuenta de gestión.
# -----------------------------------------------------------------------------
locals {
  service_writer_role_arns = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.name_prefix}medical-consent-api",
  ]
}

data "aws_iam_policy_document" "evidence_bucket" {
  statement {
    sid       = "OnlyTheServiceAppends"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.evidence.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = local.service_writer_role_arns
    }
  }

  statement {
    sid       = "WriteOnce"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.evidence.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    # Con la clave ausente, StringNotEquals es verdadero: sin cabecera, denegado.
    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = data.aws_iam_policy_document.evidence_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.evidence]
}

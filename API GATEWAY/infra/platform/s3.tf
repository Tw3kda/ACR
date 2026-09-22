# =============================================================================
# Bucket de los PDFs firmados.
#
# La app nunca sube a través del gateway: pide una URL firmada de vida corta y
# hace el PUT directo aquí. Por eso el CORS de este bucket es un recurso propio
# —el del HTTP API no cubre esta petición— y por eso el checksum viaja firmado
# dentro de la URL: S3 recalcula el SHA-256 al recibir y responde `BadDigest`
# si el cuerpo no cuadra. La verificación la hace S3, no nuestro código.
#
# Object Lock se habilita **al crear el bucket** y no hay forma de añadirlo
# después sin destruirlo y recrearlo. Con PDFs firmados dentro eso no es una
# opción, así que se habilita ahora aunque la regla de retención quede para
# más adelante. Ver `object_lock_default_retention_days` en variables.tf.
# =============================================================================

locals {
  # Los nombres de bucket son globales en todo AWS. Sin el id de cuenta, un
  # `medical-consent-pdfs-bucket` a secas falla con BucketAlreadyExists.
  pdf_bucket_name = coalesce(
    var.pdf_bucket_name,
    "${local.name_prefix}medical-consent-pdfs-${data.aws_caller_identity.current.account_id}"
  )
}

resource "aws_s3_bucket" "pdfs" {
  bucket = local.pdf_bucket_name

  # Irreversible salvo recreando el bucket.
  object_lock_enabled = true

  # Que un `terraform destroy` no pueda llevarse consentimientos por delante.
  force_destroy = false

  tags = {
    Name = local.pdf_bucket_name
  }
}

# Object Lock exige versionado. AWS lo activa solo al habilitarlo, pero dejarlo
# explícito evita que un `plan` posterior lo vea como deriva.
resource "aws_s3_bucket_versioning" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Sin ACLs: el único camino de escritura es la URL firmada.
resource "aws_s3_bucket_ownership_controls" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Cifrado por defecto SSE-S3. Con esto puesto, PDF_SSE_KMS_KEY_ID en el Lambda
# queda vacío y la URL firmada no arrastra cabeceras de cifrado que la app
# tendría que reenviar exactas.
resource "aws_s3_bucket_server_side_encryption_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Cada PDF queda bloqueado `pdf_retention_days` desde que llega.
resource "aws_s3_bucket_object_lock_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.pdf_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.pdfs]
}

# El PDF se retira un día después de vencer su bloqueo. Es S3 quien actúa: no
# pasa por IAM ni por la SCP, así que nadie tiene que acordarse de borrar y
# nadie puede borrar antes.
resource "aws_s3_bucket_lifecycle_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  rule {
    id     = "expire-after-retention"
    status = "Enabled"

    filter {}

    expiration {
      days = var.pdf_retention_days + 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.pdfs]
}

# La notificación s3:ObjectCreated:* hacia el verificador está en lambda.tf,
# junto a la función que invoca: S3 valida el permiso de invocación al crearla,
# así que tiene que declararse después de la Lambda y de su permission.

output "pdf_bucket" {
  description = "Valor de PDF_BUCKET en el Lambda."
  value       = aws_s3_bucket.pdfs.id
}

output "pdf_bucket_arn" {
  value = aws_s3_bucket.pdfs.arn
}

# -----------------------------------------------------------------------------
# Política del bucket: solo el servicio escribe PDFs, y nadie sobreescribe.
# El API recibe el PDF en la misma petición que el log, lo verifica y lo
# guarda con `If-None-Match: *`; un administrador con la consola, no entra.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "pdfs_bucket" {
  statement {
    sid       = "OnlyTheServiceAppends"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.pdfs.arn}/*"]

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
    resources = ["${aws_s3_bucket.pdfs.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id
  policy = data.aws_iam_policy_document.pdfs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.pdfs]
}

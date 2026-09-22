# =============================================================================
# Usuario de solo lectura para el día a día.
#
# `terraform-deploy` es administrador y solo debe usarse para desplegar. Para
# mirar consentimientos, logs y el rastro se usa este usuario, que puede leer
# todo lo relevante y no puede escribir nada. Si su clave se filtra, lo peor
# que pasa es una fuga de lectura, nunca una alteración.
#
# Terraform crea el usuario y su política, pero NO sus credenciales: una clave
# de acceso o una contraseña de consola en el estado de Terraform es una copia
# de más. Se generan por CLI una vez creado el usuario:
#
#   # consola (contraseña de un solo uso; pide cambiarla al entrar)
#   aws iam create-login-profile --user-name auditor --password 'Temporal2026!' --password-reset-required
#   # o CLI
#   aws iam create-access-key --user-name auditor
#
# Y la URL de la consola: https://781485980004.signin.aws.amazon.com/console
# =============================================================================

resource "aws_iam_user" "auditor" {
  name = "${local.name_prefix}auditor"

  tags = {
    Purpose = "lectura de consentimientos y auditoría"
  }
}

data "aws_iam_policy_document" "auditor" {
  # Evidencia y PDFs: listar y descargar, versiones incluidas.
  # Listar por prefijo del índice ES la consulta: no hay base de datos.
  statement {
    sid = "ReadEvidence"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectAttributes",
      "s3:GetObjectRetention",
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:GetBucketObjectLockConfiguration",
    ]

    resources = [
      aws_s3_bucket.evidence.arn,
      "${aws_s3_bucket.evidence.arn}/*",
      aws_s3_bucket.pdfs.arn,
      "${aws_s3_bucket.pdfs.arn}/*",
    ]
  }

  # Logs de ejecución y del gateway.
  statement {
    sid = "ReadRuntimeLogs"

    actions = [
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartQuery",
      "logs:GetQueryResults",
    ]

    resources = ["*"]
  }
  # Lo mínimo para que la consola no rompa al entrar.
  statement {
    sid = "ConsoleBasics"

    actions = [
      "s3:ListAllMyBuckets",
      "iam:GetAccountPasswordPolicy",
      "iam:ChangePassword",
      "iam:GetUser",
      "iam:ListMFADevices",
    ]

    resources = ["*"]
  }
}

resource "aws_iam_policy" "auditor" {
  name        = "${local.name_prefix}medical-consent-auditor"
  description = "Solo lectura: evidencia, PDFs, logs."
  policy      = data.aws_iam_policy_document.auditor.json
}

resource "aws_iam_user_policy_attachment" "auditor" {
  user       = aws_iam_user.auditor.name
  policy_arn = aws_iam_policy.auditor.arn
}

output "auditor_user" {
  description = "Usuario de solo lectura. Credenciales: ver cabecera de readonly_user.tf."
  value       = aws_iam_user.auditor.name
}

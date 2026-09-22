# =============================================================================
# Variables de platform/.
#
# Las que api/ también necesita (prefijo de nombres, orígenes CORS, prefijo de
# claves del PDF, vigencia del token, si el client tiene secreto) NO se
# redeclaran allí: platform/ las exporta como outputs y api/ las lee del estado
# remoto. Una sola fuente de verdad.
# =============================================================================

variable "aws_region" {
  description = "Región de todos los recursos. Debe coincidir con AWS_REGION del Lambda y con la de api/."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = <<-EOT
    Prefijo de nombres. Vacío = producción, sin prefijo. "dev" antepone "dev-"
    a la tabla, el bucket, el user pool y todo lo de api/, para que dos
    entornos convivan en la misma cuenta.

    Se decide antes del primer apply: cambiarlo después renombra —es decir,
    recrea— la tabla, el bucket y el user pool, con lo que contengan.
  EOT
  type        = string
  default     = ""
}

variable "localstack" {
  description = <<-EOT
    true al aplicar con `tflocal` contra LocalStack. Salta lo que la edición
    Community no emula: Cognito. Todo lo demás de este módulo (KMS, DynamoDB
    con sus dos índices, S3 con Object Lock, cifrado y CORS) se crea igual que
    en AWS, y es justo lo que conviene validar en local.

    Nunca true contra AWS. Lo fija infra/platform/localstack.tfvars, que solo
    usa scripts/localstack.mjs.
  EOT
  type        = bool
  default     = false
}

variable "project_tags" {
  type = map(string)
  default = {
    Application = "consentimiento-informado"
  }
}

# -----------------------------------------------------------------------------
# S3
# -----------------------------------------------------------------------------
variable "pdf_bucket_name" {
  description = <<-EOT
    Nombre del bucket de PDFs. Los nombres de bucket son globales en todo AWS,
    así que `medical-consent-pdfs-bucket` a secas es casi seguro que ya está
    cogido por otra cuenta. Si se deja en null se compone con el id de cuenta.
  EOT
  type        = string
  default     = null
}

variable "pdf_key_prefix" {
  description = "Debe coincidir con PDF_KEY_PREFIX del Lambda y con EXPO_PUBLIC_PDF_S3_PREFIX de la app."
  type        = string
  default     = "consents"
}

variable "pdf_retention_days" {
  description = <<-EOT
    Días que un PDF queda bajo Object Lock y, un día después, se retira solo.
    Decisión de negocio: el archivo definitivo del documento vive fuera de S3
    (historia clínica / paciente); aquí es tránsito, y el registro de evidencia
    conserva su hash durante `evidence_retention_days` para verificar cualquier
    copia que se presente.
  EOT
  type        = number
  default     = 30
}

variable "evidence_retention_days" {
  description = <<-EOT
    Días que cada evento del registro de auditoría queda bajo Object Lock.
    Un año. Con COMPLIANCE, el bucket no se puede eliminar hasta que expire el
    último objeto.
  EOT
  type        = number
  default     = 365
}

variable "object_lock_mode" {
  description = <<-EOT
    GOVERNANCE o COMPLIANCE, para los dos buckets bloqueados.

    Con COMPLIANCE nadie puede acortar el plazo ni borrar el objeto antes de que
    venza: ni tú, ni el usuario root, ni AWS. Es la garantía definitiva, y es
    irreversible. GOVERNANCE protege igual frente a todo el mundo salvo a quien
    tenga `s3:BypassGovernanceRetention` — permiso que la SCP deniega a toda la
    cuenta, con lo que en la práctica se comporta como COMPLIANCE mientras siga
    siendo reversible desde la cuenta de gestión.

    GOVERNANCE mientras esto sea un entorno de pruebas (los objetos de prueba se
    pueden retirar). COMPLIANCE al pasar a producción: un cambio de esta línea y
    un apply; afecta a los objetos nuevos.
  EOT
  type        = string
  default     = "GOVERNANCE"

  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.object_lock_mode)
    error_message = "object_lock_mode debe ser GOVERNANCE o COMPLIANCE."
  }
}

# -----------------------------------------------------------------------------
# Cognito
# -----------------------------------------------------------------------------
variable "cognito_client_has_secret" {
  description = <<-EOT
    Si el app client lleva secreto. **Por defecto no, y es una decisión, no un
    descuido** (Hallazgo 2 de docs/API_IMPLEMENTATION.md).

    Con secreto, `REFRESH_TOKEN_AUTH` exige `SECRET_HASH`, que necesita el
    username — y la app solo manda `{ "refresh_token": "..." }`. El backend lo
    resuelve envolviendo el refresh token junto al username
    (`COGNITO_REFRESH_USERNAME_MODE=envelope`), que funciona pero añade una capa
    que hay que mantener.

    Sin secreto el problema desaparece de raíz: quien llama a Cognito es el
    Lambda, no el dispositivo, y la protección real la dan el IAM del Lambda y
    el autorizador JWT del gateway. La app nunca ve ninguna de las dos cosas.

    Si lo pones en true, pasa el secreto al Lambda por Secrets Manager, no como
    variable de entorno. api/outputs.tf ya emite el modo `envelope` solo.
  EOT
  type        = bool
  default     = false
}

variable "access_token_hours" {
  description = "Vigencia del access token. Debe coincidir con EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS de la app (12)."
  type        = number
  default     = 12

  validation {
    # Cognito no admite más de 24 h en un access token.
    condition     = var.access_token_hours >= 1 && var.access_token_hours <= 24
    error_message = "access_token_hours debe estar entre 1 y 24."
  }
}

variable "refresh_token_days" {
  description = "Vigencia del refresh token. Más corto que esto obliga a re-login a mitad de semana."
  type        = number
  default     = 30
}

variable "cors_allowed_origins" {
  description = "Solo hace falta para `expo start --web`. En Android/iOS no aplica CORS. Lo usa el gateway (api/)."
  type        = list(string)
  default     = ["http://localhost:8081"]
}

# =============================================================================
# Variables de api/.
#
# `expose_register_route` y `api_log_retention_days` siguen declaradas en
# api_gateway.tf, junto a lo que configuran. Lo que también necesita platform/
# (región, tags) se repite aquí porque son estados separados y cada uno
# configura su propio proveedor; mantén los defaults iguales.
# =============================================================================

variable "aws_region" {
  description = "Debe coincidir con la de platform/: el estado remoto se lee de esa región."
  type        = string
  default     = "us-east-1"
}

variable "project_tags" {
  type = map(string)
  default = {
    Application = "consentimiento-informado"
  }
}

variable "cognito_token_for_app" {
  description = <<-EOT
    Qué token devuelve el login: `access` o `id`. Debe coincidir con
    COGNITO_TOKEN_FOR_APP del Lambda.

    El autorizador valida los dos, porque compara `audience` contra `aud` (que
    traen los id token) o contra `client_id` (que traen los access token). Lo
    que importa es que Lambda y autorizador hablen del mismo.
  EOT
  type        = string
  default     = "access"

  validation {
    condition     = contains(["access", "id"], var.cognito_token_for_app)
    error_message = "cognito_token_for_app debe ser access o id."
  }
}

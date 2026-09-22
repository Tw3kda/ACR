# =============================================================================
# Lo que api/ lee del estado remoto de platform/.
#
# Los outputs de cada recurso (ARN de la tabla, nombre del bucket, ids de
# Cognito, ARN de la clave) están al final de su propio archivo. Aquí va la
# configuración compartida: lo que api/ necesita saber pero no debe redeclarar.
# =============================================================================

output "name_prefix" {
  description = "Prefijo de entorno ya resuelto; api/ lo antepone a sus propios nombres."
  value       = local.name_prefix
}

output "cors_allowed_origins" {
  value = var.cors_allowed_origins
}

output "pdf_key_prefix" {
  value = var.pdf_key_prefix
}

output "access_token_hours" {
  value = var.access_token_hours
}

output "cognito_client_has_secret" {
  value = var.cognito_client_has_secret
}

output "cognito_user_pool_arn" {
  value = one(aws_cognito_user_pool.pool[*].arn)
}

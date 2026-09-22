# Solo para `tflocal`. Lo carga scripts/localstack.mjs con -var-file; nunca se
# usa contra AWS.
localstack = true

# Nombre fijo y corto: LocalStack no exige unicidad global y es el que espera
# PDF_BUCKET en .env.localstack.
pdf_bucket_name = "medical-consent-pdfs-local"

# Sin prefijo de entorno: mismos nombres que producción, para que el API
# arranque con la misma configuración.
environment = ""

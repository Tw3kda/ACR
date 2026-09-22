# =============================================================================
# SCP: nadie en la cuenta de trabajo puede alterar ni destruir la evidencia.
#
# Se aplica desde la CUENTA DE GESTIÓN de AWS Organizations, que es otra cuenta
# distinta, vacía, sin cargas de trabajo. Una SCP nunca afecta a la cuenta de
# gestión — por eso no puede ser la misma que tiene la tabla y los buckets — y
# afecta a TODO en la cuenta miembro, incluido su usuario root. Es la única
# construcción de AWS que frena a un administrador.
#
# Qué deniega en la cuenta de trabajo (ver locals.scp):
#   - escribir en los buckets de evidencia y de PDFs a cualquiera que no sea
#     uno de los roles del servicio: Object Lock impide ALTERAR; esto impide
#     FABRICAR un evento con formato correcto
#   - borrar objetos o versiones, saltarse Object Lock, apagar el versionado o
#     tocar la configuración de bloqueo, cifrado o ciclo de vida de los dos
#     buckets (evidencia, PDFs)
#
# Lo que NO deniega: desplegar. Lambda, API Gateway, ECR y las lecturas siguen
# libres. Cuando haga falta cambiar algo de lo protegido (una regla de ciclo de
# vida, por ejemplo), se desactiva la SCP desde la cuenta de gestión, se aplica
# el cambio y se vuelve a activar — un "break glass" que queda en el historial
# de eventos (90 días, sin trail) de las dos cuentas.
#
# -----------------------------------------------------------------------------
# Pasos (una sola vez):
#
#   1. Crear una cuenta nueva de AWS: será la de gestión. Otro correo (vale un
#      alias +org del mismo buzón), tarjeta, teléfono. MFA en su root. Nada
#      más se despliega ahí, nunca.
#   2. En esa cuenta: usuario IAM `org-admin` con AdministratorAccess y clave
#      de acceso →  aws configure --profile org
#   3. Crear la organización e invitar a la cuenta de trabajo:
#        aws organizations create-organization --feature-set ALL --profile org
#        aws organizations invite-account-to-organization --target Id=781485980004,Type=ACCOUNT --profile org
#   4. Aceptar desde la cuenta de trabajo (perfil por defecto = terraform-deploy):
#        aws organizations list-handshakes-for-account --query "Handshakes[?State=='OPEN'].Id" --output text
#        aws organizations accept-handshake --handshake-id <id>
#   5. Activar el tipo de política SCP en la raíz de la organización:
#        aws organizations list-roots --query "Roots[0].Id" --output text --profile org
#        aws organizations enable-policy-type --root-id <r-xxxx> --policy-type SERVICE_CONTROL_POLICY --profile org
#   6. Aplicar este módulo con el perfil de gestión:
#        terraform -chdir=infra/org init
#        terraform -chdir=infra/org apply
#   7. Comprobar desde la cuenta de trabajo que un admin ya no puede:
#        echo x | aws s3 cp - s3://medical-consent-evidence-781485980004/events/falso/0001-CONSENT_SIGNED.json
#      → AccessDenied ... with an explicit deny in a service control policy
# =============================================================================

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Estado local a propósito: este módulo vive en la cuenta de gestión, que no
  # tiene (ni debe tener) el bucket de estado de la cuenta de trabajo. Es una
  # política y un adjunto; si el estado se pierde se importan en dos líneas.
}

variable "management_profile" {
  description = "Perfil de ~/.aws con credenciales de la cuenta de gestión (org-admin)."
  type        = string
  default     = "org"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "workload_account_id" {
  description = "La cuenta donde vive el consentimiento: tabla, buckets, Lambdas."
  type        = string
  default     = "781485980004"
}

variable "name_prefix" {
  description = "Prefijo de entorno usado en la cuenta de trabajo (vacío en producción). Debe coincidir con platform/."
  type        = string
  default     = ""
}

variable "enabled" {
  description = <<-EOT
    false = la SCP existe pero no está adjunta: es el "break glass" para cambiar
    infraestructura protegida. Se pone en false, se aplica, se hace el cambio en
    la cuenta de trabajo, se vuelve a true y se aplica. Cada paso queda en el
    historial de eventos de la cuenta de gestión.
  EOT
  type        = bool
  default     = true
}

provider "aws" {
  region  = var.aws_region
  profile = var.management_profile
}

# La organización y la invitación se hacen por CLI (pasos 3-5): Terraform no
# modela el apretón de manos de una invitación. Aquí solo se lee.
data "aws_organizations_organization" "org" {}

locals {
  acct = var.workload_account_id
  p    = var.name_prefix

  evidence_bucket = "${local.p}medical-consent-evidence-${local.acct}"
  pdf_bucket      = "${local.p}medical-consent-pdfs-${local.acct}"
  writer_role_arns = [
    "arn:aws:iam::${local.acct}:role/${local.p}medical-consent-api",
  ]

  locked_buckets = [
    "arn:aws:s3:::${local.evidence_bucket}",
    "arn:aws:s3:::${local.evidence_bucket}/*",
    "arn:aws:s3:::${local.pdf_bucket}",
    "arn:aws:s3:::${local.pdf_bucket}/*",
  ]

  scp = {
    Version = "2012-10-17"
    Statement = [
      {
        # Solo el servicio escribe. Object Lock impide alterar lo que ya está;
        # esto impide que un administrador PLANTE un evento o un PDF con
        # formato correcto. El API recibe el PDF y lo guarda él mismo: no hay
        # otro principal que escriba en estos buckets.
        Sid    = "OnlyTheServiceAppends"
        Effect = "Deny"
        Action = ["s3:PutObject"]
        Resource = [
          "arn:aws:s3:::${local.evidence_bucket}/*",
          "arn:aws:s3:::${local.pdf_bucket}/*",
        ]
        Condition = {
          ArnNotLike = { "aws:PrincipalArn" = local.writer_role_arns }
        }
      },
      {
        # Nadie borra, nadie se salta el bloqueo, nadie apaga lo que lo hace
        # funcionar. Es S3 quien retira los objetos al vencer el plazo, por
        # ciclo de vida, y eso no pasa por aquí.
        Sid    = "EvidenceCannotBeDestroyed"
        Effect = "Deny"
        Action = [
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:BypassGovernanceRetention",
          "s3:PutObjectRetention",
          "s3:PutObjectLegalHold",
          "s3:DeleteBucket",
          "s3:DeleteBucketPolicy",
          "s3:PutBucketVersioning",
          "s3:PutBucketObjectLockConfiguration",
          "s3:PutLifecycleConfiguration",
          "s3:PutEncryptionConfiguration",
        ]
        Resource = local.locked_buckets
      },
    ]
  }
}

resource "aws_organizations_policy" "consent_evidence" {
  name        = "${local.p}medical-consent-evidence"
  description = "La evidencia del consentimiento firmado solo se puede añadir, nunca alterar ni destruir. Ni por root."
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode(local.scp)
}

# Adjunta directamente a la cuenta. Si más adelante hay varias cuentas de
# trabajo, se crea una OU, se mueven ahí y se adjunta a la OU.
resource "aws_organizations_policy_attachment" "workload" {
  count = var.enabled ? 1 : 0

  policy_id = aws_organizations_policy.consent_evidence.id
  target_id = var.workload_account_id
}

output "scp_id" {
  value = aws_organizations_policy.consent_evidence.id
}

output "attached" {
  value = var.enabled
}

output "organization_id" {
  value = data.aws_organizations_organization.org.id
}

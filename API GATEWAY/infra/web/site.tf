# --- Bucket del sitio ----------------------------------------------------------
# Privado del todo: solo CloudFront lo lee, vía OAC. Sin "static website
# hosting". SSE-S3: el contenido es el JavaScript que recibe cualquier
# navegador; una CMK no protegería nada y añadiría permisos y costo.
resource "aws_s3_bucket" "site" {
  bucket = "${local.site_name}-${data.aws_caller_identity.current.account_id}"

  # Solo contiene el build, que se regenera con cada despliegue.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Solo ESTA distribución puede leer (AWS:SourceArn).
data "aws_iam_policy_document" "site" {
  statement {
    sid       = "AllowCloudFrontOAC"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# --- CloudFront ------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = local.site_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Políticas gestionadas por AWS: caché para estáticos y cabeceras de seguridad
# (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy).
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# Cabeceras de seguridad propias (antes: Managed-SecurityHeadersPolicy, que no
# trae Content-Security-Policy). La CSP es la defensa principal contra XSS: el
# navegador solo ejecuta el JavaScript de este sitio y solo habla con el API y
# con el bucket de PDFs. Si alguien lograra inyectar un script, no podría
# enviar el token de sesión a ningún otro sitio.
resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${local.site_name}-security"
  comment = "CSP + cabeceras de seguridad de la web de consulta"

  security_headers_config {
    content_security_policy {
      override = true
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' ${local.api_origin}",
        "frame-src ${local.pdf_origin}",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ])
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=()"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "Web de consulta de consentimientos"
  default_root_object = "index.html"
  price_class         = var.price_class
  http_version        = "http2and3"
  is_ipv6_enabled     = true

  origin {
    origin_id                = "s3-site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "s3-site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Certificado de *.cloudfront.net: gratis y sin dominio propio.
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# --- Salidas -------------------------------------------------------------------
output "site_bucket" {
  description = "Destino del build (scripts/deploy.mjs --web)."
  value       = aws_s3_bucket.site.bucket
}

output "cloudfront_distribution_id" {
  description = "Para la invalidación tras cada despliegue."
  value       = aws_cloudfront_distribution.site.id
}

output "site_url" {
  description = "URL de la web. Debe estar en platform/terraform.tfvars -> cors_allowed_origins."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

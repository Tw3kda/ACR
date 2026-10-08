# Orígenes que el gateway (api/) acepta por CORS. Tras cambiarlo:
#   node scripts/deploy.mjs --platform && node scripts/deploy.mjs --no-build
cors_allowed_origins = [
  "http://localhost:8081",                 # expo start --web
  "http://localhost:5173",                 # vite dev (web de consulta)
  "https://d1ndwczenqtc0d.cloudfront.net", # web de consulta (output site_url de infra/web)
]

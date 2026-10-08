# Consulta de consentimientos (web)

Web para auditores: iniciar sesión, buscar por número de documento, ver y
descargar el PDF firmado, y revisar el registro de auditoría y de accesos.
Habla con el API de `API GATEWAY/` (`/auth/login`, `/auth/refresh`,
`/audit/search`, `/consents/{id}/pdf-download-url`).

## En local (sin AWS)

```bash
# terminal 1 — API con adaptadores simulados y datos de ejemplo
cd "API GATEWAY" && npm start

# terminal 2 — la web
cd "WEB PDF CHECK/my-app" && npm install && npm run dev
```

Abrir http://localhost:5173 con `demo@acrvitallaboral.com` / `Demo1234!`.
Cédulas de ejemplo: `1018293847` (2 consentimientos) y `79845123`.

## Producción (AWS)

Publicada en https://d1ndwczenqtc0d.cloudfront.net (S3 privado + CloudFront,
`API GATEWAY/infra/web`). Para publicar cambios de la web:

```bash
cd "API GATEWAY" && node scripts/deploy.mjs --web
```

Aplica `infra/web`, compila con `VITE_API_URL` = el `api_endpoint` de
`infra/api`, sube `dist/` e invalida `index.html`.

- El usuario debe estar en el grupo de Cognito `auditores` (si no, 403):
  `aws cognito-idp admin-add-user-to-group --user-pool-id <pool> --username <usuario> --group-name auditores`
  y volver a iniciar sesión.
- El dominio de la web está en `infra/platform/terraform.tfvars`
  (`cors_allowed_origins`); si cambia, `deploy.mjs --platform` y luego
  `deploy.mjs --no-build`.

## Qué queda registrado

Cada búsqueda y cada PDF visto o descargado escribe un registro inmutable en
el bucket de evidencia (`access/<cédula>/…`) antes de responder. Se ven en la
pestaña **Registro de accesos**.

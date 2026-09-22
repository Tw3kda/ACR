# Web de consulta de consentimientos — Plan de implementación

Página web (React) para que personal autorizado consulte, por cédula (CC), los
consentimientos firmados en tablet: ver los registros de auditoría, descargar
el PDF y copiar la información al portapapeles. Usa **el API que ya existe** en
`API GATEWAY/` (Express sobre Lambda, API Gateway HTTP API, Cognito, DynamoDB,
S3) y le añade dos rutas de lectura. El frontend nuevo vive en `WEB PDF CHECK/`.

Costo objetivo: **$0–1 USD/mes** (todo dentro de la capa gratuita de AWS).

---

## 0. Índice

1. [Arquitectura y decisiones](#1-arquitectura-y-decisiones)
2. [Backend — cambios en `API GATEWAY/src`](#2-backend--cambios-en-api-gatewaysrc)
3. [Terraform — `infra/platform` (Cognito, CORS)](#3-terraform--infraplatform)
4. [Terraform — `infra/api` (rutas, IAM, variables)](#4-terraform--infraapi)
5. [Terraform — `infra/web` (nuevo: S3 + CloudFront)](#5-terraform--infraweb-nuevo)
6. [Frontend — `WEB PDF CHECK/`](#6-frontend--web-pdf-check)
7. [Logs y auditoría de accesos](#7-logs-y-auditoría-de-accesos)
8. [Orden de despliegue](#8-orden-de-despliegue)
9. [Pruebas](#9-pruebas)
10. [Costos](#10-costos)
11. [Expiración de los PDF a 30 días](#11-expiración-de-los-pdf-a-30-días)
12. [CloudTrail y las capas de inmutabilidad](#12-cloudtrail-y-las-capas-de-inmutabilidad)

---

## 1. Arquitectura y decisiones

```
Navegador (React SPA, servido por CloudFront desde S3 privado)
  │
  ├─ POST /auth/login ─────────────────────┐  (sin autorizador — ya existe)
  ├─ POST /auth/refresh ───────────────────┤  (sin autorizador — ya existe)
  ├─ POST /audit/search ───────────────────┼─► API Gateway (JWT authorizer) ─► Lambda Express
  ├─ GET  /consents/{id}/pdf-download-url ─┘        │
  │                                                 ├─► Cognito   (AdminInitiateAuth)
  │                                                 ├─► DynamoDB  (Query PATIENT#<cc>, PutItem ACCESS#…)
  │                                                 └─► S3        (presign GetObject, 60 s)
  │
  └─ GET https://<bucket>.s3.amazonaws.com/consents/…pdf?X-Amz-…   ← directo a S3, descarga forzada
```

| Tema | Decisión | Motivo |
| --- | --- | --- |
| **Autenticación** | El navegador llama a `POST /auth/login` y `POST /auth/refresh` del API existente. **No** se usa Amplify ni Cognito directo desde el navegador. | El API ya hace `AdminInitiateAuth` y el JWT authorizer ya valida el token. Cero cambios en Cognito salvo un grupo. |
| **Autorización** | Grupo de Cognito `auditores`. Las rutas nuevas devuelven `403` si el token no trae ese grupo. | Un profesional de tablet no debe poder consultar a cualquier paciente. |
| **Logs por CC** | `POST /audit/search` con `{ patient_id }` en el cuerpo → Lambda → `Query PK = PATIENT#<cc>`. | El navegador nunca tiene credenciales de AWS. POST en vez de `GET /patients/{cc}` para que la cédula no quede en los access logs del gateway ni en el historial del navegador. |
| **PDF desde S3** | `GET /consents/{id}/pdf-download-url` → Lambda firma un `GetObject` de **60 s** → el navegador abre esa URL. | El bucket es privado, con KMS y Object Lock. El único "acceso directo a AWS" es la URL firmada; los bytes no pasan por Lambda (límite 6 MB). |
| **Descargar** | La URL se firma con `ResponseContentDisposition: attachment; filename="<consent_id>.pdf"` y el navegador hace `window.location.assign(url)`. | S3 fuerza la descarga. |
| **Copiar** | El navegador hace `fetch(url firmada)`, renderiza el PDF con `pdfjs-dist` y escribe en el portapapeles un `ClipboardItem` con **`image/png` (todas las páginas apiladas) + `text/plain` (texto del PDF)**. | Ningún navegador permite poner un *archivo* en el portapapeles del sistema: `clipboard.write()` solo admite texto, HTML y PNG. Word/Outlook/WhatsApp pegan la imagen; Bloc de notas/Excel pegan el texto. Exige **CORS en el bucket de PDFs** para el origen web (la regla ya existe; solo se añade el origen). |
| **Retención del PDF** | **Inmutable 30 días (Object Lock GOVERNANCE), borrado a los 30 días (lifecycle).** El log en DynamoDB y su copia WORM se conservan siempre. | S3 es una **copia de tránsito**: el PDF debe descargarse a la HCE dentro del plazo. Ver la advertencia legal en §11. |
| **Hosting** | S3 privado + CloudFront (OAC) + HTTPS del dominio `*.cloudfront.net`. | La API `navigator.clipboard` solo funciona en HTTPS. El endpoint "static website" de S3 es solo HTTP. CloudFront tiene capa gratuita permanente (1 TB + 10 M peticiones/mes). |
| **Dominio propio** | No, por ahora. | Route 53 cobra ~$0.50/mes por zona. El dominio `dxxxx.cloudfront.net` es gratis y ya tiene certificado. |

---

## 2. Backend — cambios en `API GATEWAY/src`

Resumen de archivos:

| Archivo | Cambio |
| --- | --- |
| `.env.example` | 5 variables nuevas |
| `src/config/env.js` | leer esas variables |
| `src/lib/cursor.js` | **nuevo** — codificar/decodificar `LastEvaluatedKey` |
| `src/middleware/auth.js` | `requireGroup(group)` |
| `src/aws/dynamo.aws.js` / `dynamo.stub.js` | `listLogsByPatient`, `putAccessRecord` |
| `src/aws/s3.aws.js` / `s3.stub.js` | `presignPdfGet` |
| `src/aws/cognito.stub.js` | el token simulado lleva `cognito:groups` |
| `src/services/auditQueryService.js` | **nuevo** — `searchLogsByPatient` |
| `src/services/pdfUrlService.js` | `issuePdfDownloadUrl` |
| `src/routes/audit.routes.js` | `POST /audit/search` |
| `src/routes/consents.routes.js` | `GET /consents/:consent_id/pdf-download-url` |
| `scripts/smoke.js` | 6 comprobaciones nuevas |

### 2.1 `.env.example`

Añadir al final del bloque de rutas y al de S3/auditoría:

```dotenv
# --- Rutas (web de consulta) --------------------------------------------------
PATH_AUDIT_SEARCH=/audit/search
PATH_PDF_DOWNLOAD_URL=/consents/:consent_id/pdf-download-url

# --- Web de consulta ----------------------------------------------------------
# Grupo de Cognito exigido en /audit/search y /consents/*/pdf-download-url.
# Vacío = cualquier usuario autenticado (solo para desarrollo).
AUTH_READER_GROUP=auditores
# Vida de la URL firmada de descarga. Es una autorización de lectura al
# portador: cuanto más corta, mejor. El navegador la pide justo antes de usarla.
PDF_DOWNLOAD_URL_TTL_SECONDS=60
# Tamaño de página por defecto y máximo de /audit/search.
AUDIT_SEARCH_PAGE_SIZE=25
AUDIT_SEARCH_MAX_PAGE_SIZE=100
```

### 2.2 `src/config/env.js`

```js
  routes: {
    // ...existentes...
    auditSearch: str(raw.PATH_AUDIT_SEARCH, '/audit/search'),
    pdfDownloadUrl: str(raw.PATH_PDF_DOWNLOAD_URL, '/consents/:consent_id/pdf-download-url'),
  },

  auth: {
    // ...existentes...
    // Grupo de Cognito que habilita la consulta. Vacío = sin comprobación.
    readerGroup: str(raw.AUTH_READER_GROUP, isProduction ? 'auditores' : ''),
  },

  audit: {
    // ...existentes...
    searchPageSize: int(raw.AUDIT_SEARCH_PAGE_SIZE, 25),
    searchMaxPageSize: int(raw.AUDIT_SEARCH_MAX_PAGE_SIZE, 100),
  },

  s3: {
    // ...existentes...
    downloadUrlTtlSeconds: int(raw.PDF_DOWNLOAD_URL_TTL_SECONDS, 60),
  },
```

### 2.3 `src/lib/cursor.js` (nuevo)

```js
import { badRequest } from './errors.js';

/**
 * El cursor de paginación es el LastEvaluatedKey de DynamoDB en base64url.
 * Al decodificarlo se comprueba que apunte a la misma partición que se está
 * consultando: un cursor no puede servir para saltar a otro paciente.
 */
export const encodeCursor = (key) =>
  key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : null;

export function decodeCursor(cursor, expectedPk) {
  if (!cursor) return undefined;
  let key;
  try {
    key = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Cursor de paginación inválido');
  }
  if (!key || typeof key.PK !== 'string' || typeof key.SK !== 'string' || key.PK !== expectedPk) {
    throw badRequest('Cursor de paginación inválido');
  }
  return { PK: key.PK, SK: key.SK };
}
```

### 2.4 `src/middleware/auth.js` — `requireGroup`

Añadir al final del archivo:

```js
import { forbidden } from '../lib/errors.js';

/**
 * El JWT authorizer de un HTTP API entrega las claims de tipo lista como
 * cadena: `cognito:groups` llega como "[auditores]" (o "[a b]" con varios),
 * no como arreglo. En modo local (Bearer decodificado) sí es un arreglo.
 */
function groupsFrom(claims) {
  const raw = claims?.['cognito:groups'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    return raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

/**
 * Exige pertenencia a un grupo de Cognito. Va SIEMPRE después de requireAuth.
 * Responde 403 y no 401: el token es válido, lo que faltan son permisos, y un
 * 401 haría que el cliente renovase la sesión y reintentase inútilmente.
 */
export const requireGroup = (group) => (req, res, next) => {
  if (!group) return next();
  const groups = groupsFrom(req.ctx?.claims);
  if (groups.includes(group)) {
    req.ctx.groups = groups;
    return next();
  }
  return next(
    forbidden('No tiene permiso para consultar consentimientos', {
      details: { required_group: group },
    }),
  );
};
```

### 2.5 `src/aws/dynamo.aws.js`

```js
import { encodeCursor } from '../lib/cursor.js';

// Lo que la web muestra en la tabla y en el detalle. `biometrics_json` queda
// fuera a propósito: es el 90 % del ítem y no se consulta al listar.
const LIST_PROJECTION = {
  ProjectionExpression: [
    '#pk', '#sk', '#log_id', '#consent_id', '#ts', '#et', '#subject', '#sig',
    '#cap', '#dev', '#recv', '#pv', '#pva', '#psz', '#pui',
  ].join(', '),
  ExpressionAttributeNames: {
    '#pk': 'PK', '#sk': 'SK', '#log_id': 'log_id', '#consent_id': 'consent_id',
    '#ts': 'timestamp_utc', '#et': 'event_type', '#subject': 'subject',
    '#sig': 'signature_data', '#cap': 'capture_metadata', '#dev': 'device_context',
    '#recv': 'received_at_utc', '#pv': 'pdf_verified', '#pva': 'pdf_verified_at',
    '#psz': 'pdf_size_bytes', '#pui': 'pdf_url_issued_at',
  },
};

/**
 * Página de registros de un paciente, del más reciente al más antiguo.
 * `skPrefix` = 'LOG#' (firmas) o 'ACCESS#' (consultas y descargas, sección 7).
 */
export async function listLogsByPatient({ patientId, skPrefix = 'LOG#', limit, exclusiveStartKey }) {
  const res = await getDoc().send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
      ...LIST_PROJECTION,
      ExpressionAttributeValues: { ':pk': `PATIENT#${patientId}`, ':sk': skPrefix },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: false,
    }),
  );
  return { items: res.Items ?? [], nextCursor: encodeCursor(res.LastEvaluatedKey) };
}

/**
 * Registro de acceso (consulta o descarga). Misma tabla, prefijo ACCESS# en la
 * SK: no aparece al listar LOG#, y el stream lo copia al bucket WORM igual que
 * a cualquier otro ítem. Sin condición: cada acceso es un ítem nuevo.
 */
export async function putAccessRecord(item) {
  await getDoc().send(new PutCommand({ TableName: tableName, Item: item }));
}
```

`src/aws/dynamo.stub.js` — mismo contrato, en memoria:

```js
export async function listLogsByPatient({ patientId, skPrefix = 'LOG#', limit, exclusiveStartKey }) {
  const pk = `PATIENT#${patientId}`;
  const all = [...items.values()]
    .filter((it) => it.PK === pk && it.SK.startsWith(skPrefix))
    .sort((a, b) => (a.SK < b.SK ? 1 : -1)); // descendente, como ScanIndexForward:false

  const start = exclusiveStartKey ? all.findIndex((it) => it.SK === exclusiveStartKey.SK) + 1 : 0;
  const page = all.slice(start, start + limit).map(({ biometrics_json, ...rest }) => structuredClone(rest));
  const last = start + limit < all.length ? page.at(-1) : null;

  traceAws({
    service: 'DynamoDB',
    operation: 'Query',
    note: `partición del paciente, prefijo ${skPrefix}`,
    input: {
      TableName: config.dynamo.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: false,
    },
    output: { count: page.length, hasMore: Boolean(last) },
  });

  return { items: page, nextCursor: last ? encodeCursor({ PK: last.PK, SK: last.SK }) : null };
}

export async function putAccessRecord(item) {
  traceAws({
    service: 'DynamoDB',
    operation: 'PutItem',
    note: 'registro de acceso (ACCESS#)',
    input: { TableName: config.dynamo.tableName, Item: item },
  });
  items.set(keyOf(item.PK, item.SK), structuredClone(item));
}
```

### 2.6 `src/aws/s3.aws.js`

```js
import { S3Client, PutObjectCommand, GetObjectCommand, GetObjectAttributesCommand } from '@aws-sdk/client-s3';

/**
 * URL firmada de lectura. `ResponseContentDisposition` hace que S3 responda con
 * `Content-Disposition: attachment`, así el navegador descarga en vez de
 * navegar al PDF, y sin necesitar CORS en el bucket.
 *
 * El permiso se evalúa contra quien firma (el rol de la Lambda): necesita
 * s3:GetObject sobre la clave y kms:Decrypt sobre la CMK del bucket.
 */
export async function presignPdfGet({ bucket, key, filename }) {
  const expiresIn = config.s3.downloadUrlTtlSeconds;
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const url = await getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: bucket ?? config.s3.bucket,
      Key: key,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `attachment; filename="${safeName}"`,
    }),
    { expiresIn },
  );
  return { url, expiresIn, filename: safeName };
}
```

`src/aws/s3.stub.js`:

```js
export async function presignPdfGet({ bucket, key, filename }) {
  const b = bucket ?? config.s3.bucket ?? 'stub-consent-pdfs';
  const expiresIn = config.s3.downloadUrlTtlSeconds;
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const params = new URLSearchParams({
    'response-content-type': 'application/pdf',
    'response-content-disposition': `attachment; filename="${safeName}"`,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-Signature': 'stub-signature-no-valida',
  });

  traceAws({
    service: 'S3',
    operation: 'getSignedUrl(GetObjectCommand)',
    note: `caduca en ${expiresIn} s`,
    input: { Bucket: b, Key: key, ResponseContentDisposition: `attachment; filename="${safeName}"` },
  });

  return {
    url: `https://${b}.s3.${config.s3.region}.amazonaws.com/${key}?${params}`,
    expiresIn,
    filename: safeName,
  };
}
```

### 2.7 `src/aws/cognito.stub.js`

En `issueToken`, añadir la claim de grupo al payload para que la comprobación se
pueda ejercitar en local:

```js
    scope: 'aws.cognito.signin.user.admin',
    // El usuario semilla pertenece al grupo de consulta. Cognito real emite la
    // claim como arreglo en el token; el authorizer del gateway la convierte en
    // cadena "[auditores]" — requireGroup entiende las dos formas.
    'cognito:groups': ['auditores'],
```

### 2.8 `src/services/auditQueryService.js` (nuevo)

```js
import config from '../config/env.js';
import { dynamo } from '../aws/index.js';
import { badRequest } from '../lib/errors.js';
import { decodeCursor } from '../lib/cursor.js';
import logger from '../lib/logger.js';

// Cédula de ciudadanía: solo dígitos. Otros tipos (CE, TI, PA) admiten letras;
// el límite de 20 cubre todos y evita que el PK sea una cadena arbitraria.
const PATIENT_ID = /^[A-Za-z0-9]{4,20}$/;
const KINDS = new Set(['logs', 'access']);

/**
 * Registro de acceso en la propia tabla (SK ACCESS#…). Se guarda ANTES de
 * responder: si falla la escritura, no se responde la consulta. Un acceso a
 * datos clínicos sin rastro no debe ocurrir.
 */
export async function recordAccess({ patientId, eventType, consentId, ctx, extra = {} }) {
  const at = new Date().toISOString();
  await dynamo.putAccessRecord({
    PK: `PATIENT#${patientId}`,
    SK: `ACCESS#${at}#${consentId ?? '-'}#${String(ctx.requestId).slice(0, 8)}`,
    event_type: eventType,
    consent_id: consentId ?? null,
    timestamp_utc: at,
    operator_id: ctx.operatorId,
    operator_groups: ctx.groups ?? [],
    ip_address: ctx.sourceIp,
    user_agent: ctx.userAgent ?? null,
    request_id: ctx.requestId,
    ...extra,
  });
}

export async function searchLogsByPatient({ patientId, kind = 'logs', limit, cursor, ctx }) {
  const id = String(patientId ?? '').trim();
  if (!PATIENT_ID.test(id)) {
    throw badRequest('El campo "patient_id" debe ser un número de documento válido');
  }
  if (!KINDS.has(kind)) throw badRequest('El campo "kind" debe ser "logs" o "access"');

  const size = Math.min(
    Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : config.audit.searchPageSize,
    config.audit.searchMaxPageSize,
  );
  const exclusiveStartKey = decodeCursor(cursor, `PATIENT#${id}`);

  await recordAccess({ patientId: id, eventType: 'PATIENT_LOGS_SEARCHED', ctx, extra: { kind } });

  const { items, nextCursor } = await dynamo.listLogsByPatient({
    patientId: id,
    skPrefix: kind === 'access' ? 'ACCESS#' : 'LOG#',
    limit: size,
    exclusiveStartKey,
  });

  logger.info('consulta de registros por paciente', {
    operator_id: ctx.operatorId,
    kind,
    count: items.length,
    has_more: Boolean(nextCursor),
    request_id: ctx.requestId,
  });

  return { patient_id: id, kind, items, next_cursor: nextCursor };
}
```

### 2.9 `src/services/pdfUrlService.js` — `issuePdfDownloadUrl`

Añadir al final del archivo (reutiliza `findLog`):

```js
import { recordAccess } from './auditQueryService.js';

/**
 * URL firmada de lectura para la web de consulta. Solo se entrega si el PDF
 * quedó verificado por el verificador de S3: un documento cuyo checksum no
 * cuadra con el log no debe circular como si fuera el consentimiento.
 */
export async function issuePdfDownloadUrl({ consentId, ctx }) {
  if (!isSafeId(consentId)) throw badRequest('Identificador de consentimiento inválido');

  const log = await findLog(consentId, null);
  if (!log) throw notFound('No existe un registro de auditoría para este consentimiento');

  const bucket = log?.capture_metadata?.pdf_s3_bucket;
  const key = log?.capture_metadata?.pdf_s3_key;
  if (!bucket || !key) {
    throw conflict('El consentimiento no tiene un PDF asociado todavía');
  }
  if (log.pdf_verified !== true) {
    throw conflict('El PDF de este consentimiento no ha sido verificado', {
      details: { pdf_verified: log.pdf_verified ?? null },
    });
  }

  const patientId = String(log.PK).replace(/^PATIENT#/, '');
  const signed = await s3.presignPdfGet({ bucket, key, filename: `${consentId}.pdf` });

  await recordAccess({
    patientId,
    eventType: 'PDF_DOWNLOAD_URL_ISSUED',
    consentId,
    ctx,
    extra: { pdf_s3_key: key, url_expires_in: signed.expiresIn, pdf_sha256: log.signature_data?.pdf_sha256 ?? null },
  });

  logger.info('URL de descarga firmada', {
    consent_id: consentId,
    operator_id: ctx.operatorId,
    expires_in: signed.expiresIn,
    request_id: ctx.requestId,
  });

  return {
    url: signed.url,
    method: 'GET',
    expires_in: signed.expiresIn,
    filename: signed.filename,
    pdf_sha256: log.signature_data?.pdf_sha256 ?? null,
    pdf_size_bytes: log.pdf_size_bytes ?? null,
    verified: true,
  };
}
```

### 2.10 Rutas

`src/routes/audit.routes.js`:

```js
import { requireAuth, requireGroup } from '../middleware/auth.js';
import { searchLogsByPatient } from '../services/auditQueryService.js';

// Web de consulta. POST a propósito: la cédula viaja en el cuerpo y no en la
// URL, así no queda en los access logs del gateway ni en el historial.
router.post(
  config.routes.auditSearch,
  requireAuth,
  requireGroup(config.auth.readerGroup),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const result = await searchLogsByPatient({
        patientId: body.patient_id,
        kind: body.kind,
        limit: body.limit,
        cursor: body.cursor,
        ctx: { ...req.ctx, userAgent: req.get('user-agent') },
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);
```

`src/routes/consents.routes.js`:

```js
import { requireAuth, requireGroup } from '../middleware/auth.js';
import { issuePdfDownloadUrl, issuePdfUploadUrl } from '../services/pdfUrlService.js';

router.get(
  config.routes.pdfDownloadUrl,
  requireAuth,
  requireGroup(config.auth.readerGroup),
  async (req, res, next) => {
    try {
      const result = await issuePdfDownloadUrl({
        consentId: req.params.consent_id,
        ctx: { ...req.ctx, userAgent: req.get('user-agent') },
      });
      // La URL es una autorización al portador: que ningún proxy la guarde.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);
```

### 2.11 Contrato de las rutas nuevas

**`POST /audit/search`** — JWT + grupo `auditores`

```json
{ "patient_id": "1018293847", "kind": "logs", "limit": 25, "cursor": null }
```

→ `200`

```json
{
  "patient_id": "1018293847",
  "kind": "logs",
  "items": [ { "PK": "...", "SK": "...", "consent_id": "...", "timestamp_utc": "...", "event_type": "CONSENT_SIGNED", "subject": {}, "signature_data": {}, "capture_metadata": {}, "device_context": {}, "pdf_verified": true, "pdf_size_bytes": 384512 } ],
  "next_cursor": "eyJQSyI6..."
}
```

`kind: "access"` devuelve los registros `ACCESS#` (quién consultó y descargó). Errores: `400` cédula/cursor inválido, `401` token, `403` sin grupo.

**`GET /consents/{consent_id}/pdf-download-url`** — JWT + grupo `auditores`

→ `200`

```json
{ "url": "https://…s3.amazonaws.com/consents/2026/08/CONS-2026-0831-042.pdf?X-Amz-…", "method": "GET", "expires_in": 60, "filename": "CONS-2026-0831-042.pdf", "pdf_sha256": "119462bb…", "pdf_size_bytes": 384512, "verified": true }
```

Errores: `404` sin log, `409` sin PDF o `pdf_verified !== true`, `403` sin grupo.

### 2.12 `scripts/smoke.js` — comprobaciones a añadir

Después del bloque del verificador (el log ya existe y está verificado):

```js
const claims = { sub: 'seed-user-1', 'cognito:groups': '[auditores]' };      // como lo entrega el gateway
const sinGrupo = { sub: 'seed-user-2', 'cognito:groups': '[profesionales]' };

// 1. Búsqueda por cédula
let r = await api(event('POST', '/audit/search', { patient_id: PATIENT_ID }, { claims }));
let b = JSON.parse(r.body);
check('search: 200 con el log', r.statusCode === 200 && b.items.length === 1, b);
check('search: sin biometrics_json', b.items[0].biometrics_json === undefined);
// 2. Sin grupo -> 403 (y no 401)
r = await api(event('POST', '/audit/search', { patient_id: PATIENT_ID }, { claims: sinGrupo }));
check('search: 403 sin grupo', r.statusCode === 403);
// 3. Cédula inválida
r = await api(event('POST', '/audit/search', { patient_id: '12/../x' }, { claims }));
check('search: 400 cédula inválida', r.statusCode === 400);
// 4. URL de descarga
r = await api(event('GET', `/consents/${CONSENT_ID}/pdf-download-url`, undefined, { claims }));
b = JSON.parse(r.body);
check('download-url: 200 con url firmada', r.statusCode === 200 && b.url.includes('response-content-disposition'), b);
// 5. Los accesos quedaron registrados
r = await api(event('POST', '/audit/search', { patient_id: PATIENT_ID, kind: 'access' }, { claims }));
b = JSON.parse(r.body);
check('access: 3 registros (2 búsquedas + 1 descarga)', r.statusCode === 200 && b.items.length === 3, b.items.map((i) => i.event_type));
```

Y una comprobación **antes** de correr el verificador: `download-url` debe devolver `409` mientras `pdf_verified` sea `false`.

---

## 3. Terraform — `infra/platform`

### 3.1 `cognito.tf` — grupo de consulta

```hcl
# Quien puede usar la web de consulta. La Lambda exige esta claim en
# /audit/search y /consents/*/pdf-download-url (AUTH_READER_GROUP). Un
# profesional de tablet no pertenece al grupo y recibe 403.
#
# Alta de un auditor (el usuario debe volver a iniciar sesión para que el
# token traiga el grupo):
#   aws cognito-idp admin-add-user-to-group \
#     --user-pool-id <pool> --username <correo> --group-name auditores
resource "aws_cognito_user_group" "auditores" {
  count = var.localstack ? 0 : 1

  name         = "auditores"
  user_pool_id = aws_cognito_user_pool.pool[0].id
  description  = "Consulta y descarga de consentimientos desde la web"
  precedence   = 10
}

output "cognito_reader_group" {
  value = one(aws_cognito_user_group.auditores[*].name)
}
```

### 3.2 `variables.tf` — orígenes CORS

El `default` de `cors_allowed_origins` no cambia; se pasa por `terraform.tfvars`
**después** de aplicar `infra/web` (sección 8):

```hcl
# infra/platform/terraform.tfvars
cors_allowed_origins = [
  "http://localhost:8081",                 # expo start --web
  "http://localhost:5173",                 # vite dev
  "https://d1234abcd.cloudfront.net",      # output cloudfront_domain de infra/web
]
```

Este valor alimenta a la vez el CORS del **gateway** (`api/api_gateway.tf`) y el
del **bucket de PDFs** (`platform/s3.tf`). El bucket no lo necesita para la
descarga (es una navegación, no un `fetch`), pero no estorba y deja la puerta
abierta a una vista previa en página más adelante.

---

## 4. Terraform — `infra/api`

### 4.1 `api_gateway.tf` — rutas

Añadir junto a las rutas protegidas:

```hcl
# --- Web de consulta (JWT + grupo `auditores`, comprobado en la Lambda) -------
resource "aws_apigatewayv2_route" "audit_search" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "POST /audit/search"
  target             = local.integracion
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "consent_pdf_download_url" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "GET /consents/{consent_id}/pdf-download-url"
  target             = local.integracion
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}
```

En el stage, un límite por ruta para la descarga (una URL firmada por clic, no
hace falta más) y su `depends_on`:

```hcl
  route_settings {
    route_key              = "GET /consents/{consent_id}/pdf-download-url"
    throttling_rate_limit  = 20
    throttling_burst_limit = 40
  }

  depends_on = [
    aws_apigatewayv2_route.auth_login,
    aws_apigatewayv2_route.auth_refresh,
    aws_apigatewayv2_route.auth_register,
    aws_apigatewayv2_route.consent_pdf_download_url,
  ]
```

El bloque `cors_configuration` no cambia: ya admite `GET`, `POST`, `OPTIONS` y
lee `local.platform.cors_allowed_origins`.

### 4.2 `iam.tf` — lectura del PDF

En `data "aws_iam_policy_document" "api"`, junto a `PresignPdfUpload`:

```hcl
  # Firmar la descarga desde la web de consulta. Igual que la subida: la URL
  # presignada hereda estos permisos. kms:Decrypt ya está en PdfEncryption.
  statement {
    sid       = "PresignPdfDownload"
    actions   = ["s3:GetObject"]
    resources = ["${local.platform.pdf_bucket_arn}/${local.platform.pdf_key_prefix}/*"]
  }
```

`AuditTable` ya tiene `dynamodb:PutItem` y `Query` sobre la tabla y sus índices;
no hace falta nada más para `ACCESS#`.

### 4.3 `outputs.tf` — variables de la Lambda

En `local.lambda_environment`:

```hcl
    # --- Web de consulta ---
    AUTH_READER_GROUP            = coalesce(local.platform.cognito_reader_group, "auditores")
    PDF_DOWNLOAD_URL_TTL_SECONDS = "60"
    AUDIT_SEARCH_PAGE_SIZE       = "25"
    AUDIT_SEARCH_MAX_PAGE_SIZE   = "100"
```

Y un output para el `.env` de la web:

```hcl
output "web_env" {
  description = "Lo que hay que poner en el .env.production de WEB PDF CHECK."
  value = {
    VITE_API_URL              = aws_apigatewayv2_stage.default.invoke_url
    VITE_AUTH_TOKEN_TTL_HOURS = tostring(local.platform.access_token_hours)
  }
}
```

---

## 5. Terraform — `infra/web` (nuevo)

Estado propio (`web/terraform.tfstate`), igual que `api/`. Solo lee
`name_prefix` de `platform/`. No depende de `api/` (la URL del API entra en el
build de Vite, no en Terraform).

### 5.1 `providers.tf`

```hcl
# =============================================================================
# web/ — hosting de la web de consulta.
#
#   S3 (privado) · CloudFront (OAC, HTTPS) · política del bucket
#
# Estado propio. Lee el prefijo de nombres de platform/. No toca api/: la URL
# del API se fija en el build (VITE_API_URL), y el origen de CloudFront se
# añade a platform/cors_allowed_origins una vez conocido (ver PLAN, §8).
#
#   terraform -chdir=infra/web init \
#     -backend-config="bucket=acr-consent-tfstate-<cuenta>" \
#     -backend-config="region=us-east-1"
#   terraform -chdir=infra/web apply
# =============================================================================

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    key          = "web/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.project_tags
  }
}

data "aws_caller_identity" "current" {}

data "terraform_remote_state" "platform" {
  backend = "s3"

  config = {
    bucket = "acr-consent-tfstate-${data.aws_caller_identity.current.account_id}"
    key    = "platform/terraform.tfstate"
    region = var.aws_region
  }
}

locals {
  name_prefix = data.terraform_remote_state.platform.outputs.name_prefix
  site_name   = "${local.name_prefix}medical-consent-web"
}
```

### 5.2 `variables.tf`

```hcl
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

variable "price_class" {
  description = <<-EOT
    Bordes de CloudFront que sirven el sitio. PriceClass_100 (Norteamérica y
    Europa) es el más barato; Colombia se sirve desde Miami con ~50 ms extra,
    irrelevante para un sitio estático de 1 MB. PriceClass_All añade
    Sudamérica a mayor tarifa por GB — la capa gratuita cubre 1 TB/mes en
    cualquier caso, así que solo importa si se supera.
  EOT
  type        = string
  default     = "PriceClass_100"
}
```

### 5.3 `s3.tf`

```hcl
# Bucket del sitio. Privado del todo: solo CloudFront lo lee, vía OAC. No hay
# "static website hosting" — ese endpoint es HTTP y público, y la web necesita
# HTTPS (navigator.clipboard no funciona sin él).
resource "aws_s3_bucket" "site" {
  bucket = "${local.site_name}-${data.aws_caller_identity.current.account_id}"
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

# SSE-S3 y no KMS: el contenido es público por definición (es el JavaScript que
# recibe cualquier navegador) y KMS añadiría permisos al OAC y costo por
# petición sin proteger nada.
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Solo la distribución de abajo puede leer. `AWS:SourceArn` evita que otra
# distribución de otra cuenta con OAC lea este bucket.
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
```

### 5.4 `cloudfront.tf`

```hcl
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = local.site_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Políticas gestionadas por AWS: caché optimizada para estáticos y cabeceras
# de seguridad (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy).
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
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
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  # SPA: cualquier ruta que no sea un archivo (/buscar, /consentimiento/…) es
  # index.html y el router de React decide. Con OAC, S3 responde 403 —no 404—
  # a un objeto inexistente, de ahí las dos entradas.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Certificado de *.cloudfront.net: gratis y sin dominio propio.
  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }
}
```

### 5.5 `outputs.tf`

```hcl
output "site_bucket" {
  description = "Destino del `aws s3 sync dist/` (scripts/deploy-web.mjs)."
  value       = aws_s3_bucket.site.bucket
}

output "cloudfront_distribution_id" {
  description = "Para la invalidación tras cada despliegue."
  value       = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain" {
  description = "URL de la web. Añadir como https://<esto> a platform/cors_allowed_origins."
  value       = aws_cloudfront_distribution.site.domain_name
}
```

---

## 6. Frontend — `WEB PDF CHECK/`

**Stack:** Vite + React 18 + TypeScript, `react-router-dom`, `axios`. Sin
librería de UI: CSS plano con variables. Sin estado global más allá de un
`AuthContext`.

```
WEB PDF CHECK/
├─ IMPLEMENTATION_PLAN.md          (este archivo)
├─ .env.example                    VITE_API_URL=http://localhost:3000
│                                  VITE_AUTH_TOKEN_TTL_HOURS=12
├─ .env.production                 (del output web_env de infra/api; no se versiona)
├─ index.html
├─ package.json
├─ vite.config.ts
├─ scripts/deploy-web.mjs          build → s3 sync → invalidación
└─ src/
   ├─ main.tsx
   ├─ App.tsx                      rutas: /login, / (búsqueda), /paciente/:cc
   ├─ styles/theme.css
   ├─ api/client.ts                axios + Bearer + 401→refresh→reintento
   ├─ api/auth.ts                  login, refresh
   ├─ api/audit.ts                 searchLogs, getPdfDownloadUrl
   ├─ auth/AuthContext.tsx         sesión en memoria + sessionStorage
   ├─ auth/RequireAuth.tsx
   ├─ pages/LoginPage.tsx
   ├─ pages/SearchPage.tsx
   ├─ pages/PatientPage.tsx        tabla de logs + pestaña de accesos
   ├─ components/LogsTable.tsx
   ├─ components/LogDetail.tsx     panel lateral con el JSON del registro
   ├─ components/PdfActions.tsx    Descargar · Copiar
   ├─ components/Toast.tsx
   └─ lib/format.ts                fechas, tamaño, texto para el portapapeles
```

### 6.1 Inicio

```bash
cd "WEB PDF CHECK"
npm create vite@latest . -- --template react-ts
npm i react-router-dom axios pdfjs-dist
```

`pdfjs-dist` es el motor de PDF de Firefox: renderiza páginas a `<canvas>` y
extrae texto en el navegador. Solo se usa para **Copiar**; Descargar no lo
necesita.

### 6.2 `src/styles/theme.css`

```css
:root {
  --blue-700: #164a8a;
  --blue-600: #1e5aa8;
  --blue-100: #e3edf9;
  --green-600: #2e9e6b;
  --green-100: #e2f5ec;
  --ink: #1f2933;
  --ink-muted: #5f6b76;
  --line: #d9e1e8;
  --bg: #f6f8fa;
  --surface: #ffffff;
  --danger: #c0392b;
  --radius: 8px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font); color: var(--ink); background: var(--bg); }

.topbar { background: var(--blue-600); color: #fff; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
.topbar .brand { font-weight: 600; letter-spacing: .2px; }

.container { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; }

.btn { border: 0; border-radius: var(--radius); padding: 10px 16px; font-weight: 600; cursor: pointer; }
.btn-primary { background: var(--blue-600); color: #fff; }
.btn-primary:hover { background: var(--blue-700); }
.btn-success { background: var(--green-600); color: #fff; }
.btn-ghost { background: var(--blue-100); color: var(--blue-700); }
.btn:disabled { opacity: .5; cursor: not-allowed; }

.input { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius); font-size: 16px; }
.input:focus { outline: 2px solid var(--blue-600); border-color: transparent; }

table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 12px; text-transform: uppercase; color: var(--ink-muted); padding: 10px 8px; border-bottom: 2px solid var(--line); }
td { padding: 12px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }

.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge-ok { background: var(--green-100); color: var(--green-600); }
.badge-warn { background: #fdf1e0; color: #b7791f; }

.error { color: var(--danger); font-size: 14px; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--green-600); color: #fff; padding: 10px 18px; border-radius: var(--radius); }
```

### 6.3 `src/api/client.ts` — la parte que importa

Misma regla que la app de tablet: **un `401` renueva la sesión y reintenta una
sola vez**; si el refresh falla, se cierra la sesión. Los `403` se muestran tal
cual (`response.data.message`).

```ts
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { session } from '../auth/session';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL, timeout: 15000 });

api.interceptors.request.use((cfg) => {
  const token = session.get()?.token;
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

let refreshing: Promise<string> | null = null;

async function refreshToken(): Promise<string> {
  const current = session.get();
  if (!current?.refreshToken) throw new Error('sin refresh token');
  // Las renovaciones simultáneas se agrupan en una sola petición.
  refreshing ??= axios
    .post(`${import.meta.env.VITE_API_URL}/auth/refresh`, { refresh_token: current.refreshToken })
    .then(({ data }) => {
      session.set({ ...current, token: data.token, refreshToken: data.refreshToken ?? current.refreshToken, issuedAt: Date.now() });
      return data.token as string;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const cfg = error.config as InternalAxiosRequestConfig & { _retried?: boolean };
  if (error.response?.status === 401 && cfg && !cfg._retried && !cfg.url?.includes('/auth/')) {
    cfg._retried = true;
    try {
      const token = await refreshToken();
      cfg.headers.Authorization = `Bearer ${token}`;
      return api(cfg);
    } catch {
      session.clear();
      window.location.assign('/login');
    }
  }
  return Promise.reject(error);
});

/** Mensaje para el usuario: el backend siempre manda `message`. */
export const errorMessage = (e: unknown) =>
  (e as AxiosError<{ message?: string }>)?.response?.data?.message ?? 'No se pudo completar la operación';
```

`src/auth/session.ts` — sesión en `sessionStorage` (muere al cerrar la pestaña):

```ts
export type Session = { token: string; refreshToken: string; user: { id: string; email: string; name: string }; issuedAt: number };
const KEY = 'acr.session';
export const session = {
  get: (): Session | null => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; } },
  set: (s: Session) => sessionStorage.setItem(KEY, JSON.stringify(s)),
  clear: () => sessionStorage.removeItem(KEY),
};
```

`AuthContext` además programa una renovación al **90 %** de
`VITE_AUTH_TOKEN_TTL_HOURS` (10,8 h con 12) con `setTimeout`, y otra al volver
la pestaña al primer plano (`visibilitychange`).

### 6.4 `src/api/audit.ts`

```ts
import { api } from './client';

export type LogItem = {
  PK: string; SK: string; consent_id: string; timestamp_utc: string; event_type: string;
  subject?: { patient_id: string; id_type: string; full_name: string; medical_exam_type: string };
  signature_data?: { pdf_sha256?: string; document_version?: string };
  capture_metadata?: { operator_id: string; clinic_location_id: string; pdf_s3_key?: string };
  device_context?: { device_brand?: string; device_model?: string; app_version?: string };
  pdf_verified?: boolean; pdf_verified_at?: string; pdf_size_bytes?: number | null;
};

export type SearchResponse = { patient_id: string; kind: 'logs' | 'access'; items: LogItem[]; next_cursor: string | null };

export const searchLogs = (patient_id: string, kind: 'logs' | 'access' = 'logs', cursor?: string | null) =>
  api.post<SearchResponse>('/audit/search', { patient_id, kind, limit: 25, cursor: cursor ?? null }).then((r) => r.data);

export type DownloadUrl = { url: string; expires_in: number; filename: string; pdf_sha256: string | null; pdf_size_bytes: number | null; verified: boolean };

export const getPdfDownloadUrl = (consentId: string) =>
  api.get<DownloadUrl>(`/consents/${encodeURIComponent(consentId)}/pdf-download-url`).then((r) => r.data);
```

### 6.5 `src/lib/pdf.ts` — traer y convertir el PDF en el navegador

> **Por qué no se puede "copiar el archivo".** El portapapeles del sistema
> operativo sí admite archivos (así funciona Ctrl+C sobre un `.pdf` en el
> Explorador), pero **la API que los navegadores exponen a una página web no**:
> `navigator.clipboard.write()` solo acepta `text/plain`, `text/html` e
> `image/png`. Es una restricción de seguridad de Chrome, Edge, Firefox y
> Safari. Lo más cercano es copiar el PDF **como imagen** (para Word, Outlook,
> Gmail, WhatsApp, Teams) **y como texto** (para Bloc de notas, Excel) en el
> mismo `ClipboardItem`: la aplicación receptora elige el formato más rico que
> soporte.

```ts
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getPdfDownloadUrl, DownloadUrl } from '../api/audit';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Pide la URL firmada y trae los bytes. Esta es la ÚNICA petición del
 * navegador que va a S3 con fetch(): exige que el bucket permita el origen de
 * la web en su CORS (platform/s3.tf, `cors_allowed_origins`).
 */
export async function fetchPdf(consentId: string): Promise<{ dl: DownloadUrl; bytes: Uint8Array }> {
  const dl = await getPdfDownloadUrl(consentId);
  const res = await fetch(dl.url);
  if (!res.ok) throw new Error(res.status === 404 ? 'El PDF ya no está disponible' : `S3 respondió ${res.status}`);
  return { dl, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** Todas las páginas apiladas en un solo PNG (escala 2 = ~150 dpi). */
export async function renderToPng(bytes: Uint8Array, scale = 2): Promise<Blob> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: HTMLCanvasElement[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    pages.push(canvas);
  }
  const out = document.createElement('canvas');
  out.width = Math.max(...pages.map((p) => p.width));
  out.height = pages.reduce((h, p) => h + p.height, 0);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const p of pages) { ctx.drawImage(p, 0, y); y += p.height; }
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
}

/** Texto plano del PDF, página por página. */
export async function extractText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return parts.join('\n\n');
}
```

### 6.6 `src/components/PdfActions.tsx`

```tsx
import { useState } from 'react';
import { getPdfDownloadUrl, LogItem } from '../api/audit';
import { errorMessage } from '../api/client';
import { extractText, fetchPdf, renderToPng } from '../lib/pdf';

export function PdfActions({ log, onToast }: { log: LogItem; onToast: (m: string, kind?: 'ok' | 'error') => void }) {
  const [busy, setBusy] = useState<'download' | 'copy' | null>(null);
  const available = log.pdf_verified === true && !log.pdf_deleted_at && (!log.pdf_expires_at || new Date(log.pdf_expires_at) > new Date());
  const title = !log.pdf_verified ? 'El PDF aún no está verificado' : !available ? 'El PDF expiró (30 días)' : undefined;

  const download = async () => {
    setBusy('download');
    try {
      const { url } = await getPdfDownloadUrl(log.consent_id);
      // S3 responde con Content-Disposition: attachment → el navegador descarga.
      window.location.assign(url);
    } catch (e) { onToast(errorMessage(e), 'error'); } finally { setBusy(null); }
  };

  const copy = () => {
    setBusy('copy');
    // Safari exige que clipboard.write() se llame DENTRO del gesto del usuario:
    // se le pasan promesas al ClipboardItem y el navegador espera a que resuelvan.
    const pdf = fetchPdf(log.consent_id);
    const item = new ClipboardItem({
      'image/png': pdf.then(({ bytes }) => renderToPng(bytes)),
      'text/plain': pdf.then(({ bytes }) => extractText(bytes)).then((t) => new Blob([t], { type: 'text/plain' })),
    });
    navigator.clipboard.write([item])
      .then(() => onToast('PDF copiado (imagen y texto)'))
      .catch((e) => onToast(e?.message ?? errorMessage(e), 'error'))
      .finally(() => setBusy(null));
  };

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <button className="btn btn-primary" disabled={!available || busy !== null} onClick={download} title={title}>
        {busy === 'download' ? 'Preparando…' : 'Descargar PDF'}
      </button>
      <button className="btn btn-success" disabled={!available || busy !== null} onClick={copy} title={title}>
        {busy === 'copy' ? 'Copiando…' : 'Copiar'}
      </button>
    </div>
  );
}
```

Añadir a `LogItem` (§6.4): `pdf_expires_at?: string | null; pdf_deleted_at?: string | null;`.

### 6.7 Pantallas

| Pantalla | Contenido |
| --- | --- |
| `/login` | Correo + contraseña → `POST /auth/login`. Error: `message` del API. Sin registro. |
| `/` | Campo "Cédula" (solo dígitos, 4–20), botón **Buscar** (azul). Enter busca. Navega a `/paciente/:cc`. |
| `/paciente/:cc` | Cabecera con la cédula y el nombre del primer registro. Pestañas **Consentimientos** (`kind=logs`) y **Accesos** (`kind=access`). Tabla: fecha · consent_id · examen · sede · operador · estado PDF (badge verde "Verificado" / ámbar "Pendiente") · acciones. Botón "Cargar más" con `next_cursor`. Clic en fila → `LogDetail` (panel lateral con el JSON). Vacío: "Sin registros para la cédula X". |

### 6.8 `scripts/deploy-web.mjs`

```js
// node scripts/deploy-web.mjs   (requiere AWS CLI con credenciales)
import { execSync } from 'node:child_process';

const run = (cmd) => execSync(cmd, { stdio: 'inherit', shell: true });
const tf = (name) => execSync(`terraform -chdir="../API GATEWAY/infra/web" output -raw ${name}`).toString().trim();

const bucket = tf('site_bucket');
const dist = tf('cloudfront_distribution_id');

run('npm run build');
// Los assets llevan hash en el nombre: caché larga. index.html no: sin caché,
// para que un despliegue se vea de inmediato tras la invalidación.
run(`aws s3 sync dist s3://${bucket} --delete --exclude index.html --cache-control "public,max-age=31536000,immutable"`);
run(`aws s3 cp dist/index.html s3://${bucket}/index.html --cache-control "no-cache"`);
run(`aws cloudfront create-invalidation --distribution-id ${dist} --paths "/index.html"`);
```

---

## 7. Logs y auditoría de accesos

Tres capas, ninguna nueva en infraestructura (todo cae en lo que ya existe):

| Capa | Dónde | Qué registra | Retención |
| --- | --- | --- | --- |
| **Access logs del gateway** | CloudWatch `/aws/apigateway/<prefijo>medical-consent-api` (ya existe) | Cada petición: ruta, estado, IP, `userSub`, error del autorizador (los 401 que nunca llegan a la Lambda). **No** la cédula: va en el cuerpo. | 90 días (`api_log_retention_days`) |
| **Logs de la Lambda** | CloudWatch `/aws/lambda/<prefijo>medical-consent-api` (ya existe) | JSON estructurado del `logger`: `consulta de registros por paciente` (operador, cantidad), `URL de descarga firmada` (consent_id, operador). `TRACE_IO=false` en producción: nunca cuerpos completos. | 90 días |
| **Registros `ACCESS#` en DynamoDB** | Tabla `consent_audit_logs`, `PK=PATIENT#<cc>`, `SK=ACCESS#<iso>#<consent_id>#<req>` | `PATIENT_LOGS_SEARCHED` y `PDF_DOWNLOAD_URL_ISSUED`: quién (sub, grupos), cuándo, desde qué IP y navegador, qué PDF. Se escribe **antes** de responder. | Permanente. El **stream → Lambda `audit-trail` → bucket WORM** que ya existe los copia igual que a cualquier ítem: el rastro de lecturas es tan inmutable como el de firmas. |

La propia web muestra la tercera capa en la pestaña **Accesos**, así un auditor
ve quién consultó a un paciente sin entrar a la consola de AWS.

**No se activan** logs estándar de CloudFront ni de S3 para el sitio: cuestan
almacenamiento y no aportan nada que el gateway no registre ya (el sitio es
JavaScript público; lo sensible pasa por el API).

---

## 8. Orden de despliegue

```
1. Backend en local        npm start · npm run smoke           (todo simulado, sin AWS)
2. Frontend en local       VITE_API_URL=http://localhost:3000  · demo@acrvitallaboral.com / Demo1234!
3. platform/               terraform apply                     (grupo auditores)
4. api/                    node scripts/deploy.mjs             (imagen + rutas + IAM + env)
5. web/                    terraform apply                     → cloudfront_domain
6. platform/               cors_allowed_origins += https://<cloudfront_domain> → apply
7. api/                    terraform apply                     (el gateway relee el CORS)
8. Cognito                 crear usuarios auditores + admin-add-user-to-group
9. Frontend                .env.production con web_env · node scripts/deploy-web.mjs
```

Los pasos 6–7 existen porque el dominio de CloudFront no se conoce hasta el 5.
Solo se hacen una vez.

**El paso 3 incluye la retención y el lifecycle de 30 días (§11) y debe ir
antes de aplicar la SCP de `infra/org`:** la SCP deniega
`s3:PutLifecycleConfiguration` y `s3:PutBucketObjectLockConfiguration` sobre
el bucket de PDFs a toda la cuenta. Si la SCP ya está activa, hay que
desactivarla desde la cuenta de gestión, aplicar `platform/`, y volver a
activarla (el "break glass" queda en el CloudTrail de las dos cuentas).

Alta de un auditor:

```bash
aws cognito-idp admin-create-user --user-pool-id <pool> --username auditor@acrvitallaboral.com \
  --user-attributes Name=email,Value=auditor@acrvitallaboral.com Name=email_verified,Value=true Name=name,Value="Nombre Apellido" \
  --temporary-password 'Temporal2026!'
aws cognito-idp admin-set-user-password --user-pool-id <pool> --username auditor@acrvitallaboral.com --password '<definitiva>' --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id <pool> --username auditor@acrvitallaboral.com --group-name auditores
```

---

## 9. Pruebas

**Local (paso 1–2):**

```bash
# API GATEWAY
npm run smoke                                  # incluye las 6 comprobaciones nuevas
# con el servidor arriba:
TOKEN=$(curl -s localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@acrvitallaboral.com","password":"Demo1234!"}' | jq -r .token)
curl -s localhost:3000/audit/search -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"patient_id":"1018293847"}' | jq
```

**Contra AWS (tras el paso 9):**

| # | Prueba | Esperado |
| --- | --- | --- |
| 1 | Login con usuario **sin** grupo → buscar | `403` "No tiene permiso…"; **no** cierra la sesión |
| 2 | Login con auditor → buscar cédula con firmas | Tabla con los registros; sin `biometrics_json` en la red |
| 3 | Descargar con `pdf_verified: true` | El navegador descarga `CONS-….pdf`; sin errores CORS en consola |
| 4 | Abrir la misma URL 61 s después | S3 responde `403 Request has expired` |
| 5 | Descargar con `pdf_verified: false` | Botón deshabilitado; forzando la petición, `409` |
| 5b | Descargar un PDF ya expirado (> 30 días) | Botón deshabilitado; forzando la petición, `410` |
| 6 | Copiar → pegar en Word y en el Bloc de notas | Word pega la imagen con todas las páginas; el Bloc de notas pega el texto del PDF. Sin errores CORS en la consola |
| 7 | Pestaña Accesos | Aparecen las búsquedas y descargas de las pruebas 2–6 con el `sub` del auditor |
| 8 | Bucket WORM del audit-trail | Hay objetos nuevos para los ítems `ACCESS#` |
| 9 | Esperar a que caduque el access token (o borrarlo en DevTools) → buscar | Un `401` en red, refresh, reintento transparente |
| 10 | Recargar `/paciente/1018293847` directamente | CloudFront sirve `index.html` (no 403 de S3) |

---

## 10. Costos

| Servicio | Capa gratuita | Costo real estimado |
| --- | --- | --- |
| S3 (sitio, ~2 MB) | 5 GB / 12 meses | < $0.01 |
| CloudFront | **Permanente:** 1 TB + 10 M peticiones/mes | $0 |
| Certificado `*.cloudfront.net` | Permanente | $0 |
| API Gateway HTTP API | 1 M peticiones / 12 meses | Luego $1.00 por millón → centavos |
| Lambda | 1 M invocaciones/mes permanente | $0 |
| DynamoDB (on-demand) | 25 GB + lecturas/escrituras permanente | $0 (los `ACCESS#` son ~1 KB) |
| Cognito | 10 000 MAU | $0 |
| CloudWatch Logs | 5 GB ingesta/mes | $0 |
| **Total** | | **$0–1 USD/mes** |

Lo que **no** se incluye a propósito: dominio propio (Route 53, ~$0.50/mes +
dominio), logs de CloudFront, AWS WAF (no aplica a HTTP API y cuesta $5/mes).

---

## 11. Expiración de los PDF a 30 días

> **Advertencia que debe decidir la clínica, no el código.** El consentimiento
> informado es parte de la historia clínica, y la Resolución 1995/1999 (art.
> 15, modificado por la Res. 839/2017) exige conservarla **15 años**. Borrar el
> PDF de S3 a los 30 días solo es defendible si S3 es una **copia de tránsito**
> y el PDF se descarga a la HCE de la clínica (u otro archivo con su propia
> retención) dentro de ese plazo. Lo que sí queda para siempre: el log en
> DynamoDB (SHA-256 del PDF, biometría, operador, IP, hora) y su copia en el
> bucket WORM. La *evidencia* de la firma permanece; el *archivo* no.

Diseño: **inmutable 30 días → borrado**. Los dos plazos van juntos a propósito:
un PDF que no se puede alterar mientras existe y deja de existir en una fecha
conocida.

### 11.1 `infra/platform/variables.tf`

```hcl
variable "pdf_expiration_days" {
  description = <<-EOT
    Días que el PDF permanece en S3 antes de que lifecycle lo borre. Debe ser
    >= object_lock_default_retention_days: lifecycle no puede eliminar una
    versión bloqueada y la reintenta hasta que expire el bloqueo.

    Lee la advertencia de la sección 11 del plan de la web antes de
    cambiarlo: el log de auditoría se conserva; el archivo no.
  EOT
  type        = number
  default     = 30
}
```

Y en `terraform.tfvars` de `platform/`:

```hcl
object_lock_default_retention_days = 30      # antes null
object_lock_mode                   = "GOVERNANCE"
pdf_expiration_days                = 30
```

### 11.2 `infra/platform/s3.tf` — lifecycle

Sustituir el recurso `aws_s3_bucket_lifecycle_configuration.pdfs`:

```hcl
# Dos cosas: limpiar subidas cortadas a medias, y borrar cada PDF a los
# `pdf_expiration_days`. El bucket está versionado (Object Lock lo exige),
# así que `expiration` por sí sola NO borra nada: solo crea un delete marker
# y la versión sigue ocupando espacio y siendo recuperable.
# `noncurrent_version_expiration` es lo que la elimina de verdad, un día
# después — y solo cuando el bloqueo de Object Lock ya venció.
#
# La SCP de infra/org deniega s3:PutLifecycleConfiguration sobre este bucket:
# esta regla se aplica ANTES de activar la SCP.
resource "aws_s3_bucket_lifecycle_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-pdfs"
    status = "Enabled"

    filter {
      prefix = "${var.pdf_key_prefix}/"
    }

    expiration {
      days = var.pdf_expiration_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.pdfs]
}
```

Qué pasa con un PDF subido el día 0:

| Día | Evento |
| --- | --- |
| 0 | `PutObject` por URL firmada. Object Lock: retención GOVERNANCE hasta el día 30. |
| 0–30 | Nadie puede borrarlo ni sobrescribir la versión (la SCP deniega además `BypassGovernanceRetention`). La web lo descarga y copia. |
| 30 | Lifecycle crea un *delete marker*: `GetObject` responde `404`. La versión sigue existiendo, bloqueada. |
| 31 | Venció el bloqueo; `noncurrent_version_expiration` elimina la versión definitivamente. |

Los delete markers huérfanos (bytes, sin costo) se quedan; si molestan en los
listados se añade una regla con `expired_object_delete_marker = true`. El
bucket **`audit-trail` no lleva esta regla**: sigue con 365 días.

### 11.3 Backend — saber que el PDF ya no está

`.env.example` / `infra/api/outputs.tf`:

```dotenv
PDF_RETENTION_DAYS=30      # debe coincidir con pdf_expiration_days de platform/
```

`src/config/env.js`: `s3.retentionDays: int(raw.PDF_RETENTION_DAYS, 30)`.

`src/aws/s3.aws.js` — comprobar existencia antes de firmar:

```js
import { HeadObjectCommand } from '@aws-sdk/client-s3';

/** true si el objeto existe (y no está tras un delete marker). Usa s3:GetObject. */
export async function objectExists({ bucket, key }) {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: bucket ?? config.s3.bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
}
```

(`s3.stub.js`: `objectExists` devuelve `issued.has(key)`.)

`src/services/pdfUrlService.js` — en `issuePdfDownloadUrl`, tras comprobar
`pdf_verified` y antes de firmar:

```js
import { AppError } from '../lib/errors.js';
const gone = (message, opts) => new AppError(410, message, { code: 'gone', ...opts });

  if (log.pdf_deleted_at || !(await s3.objectExists({ bucket, key }))) {
    throw gone(`El PDF expiró: se conserva ${config.s3.retentionDays} días desde la firma`, {
      details: { pdf_deleted_at: log.pdf_deleted_at ?? null, retention_days: config.s3.retentionDays },
    });
  }
```

`src/services/auditQueryService.js` — en `searchLogsByPatient`, decorar cada
ítem para que la web deshabilite los botones sin hacer una petición por fila:

```js
const ms = config.s3.retentionDays * 24 * 3600 * 1000;
const decorated = items.map((it) => ({
  ...it,
  pdf_expires_at: it.timestamp_utc ? new Date(new Date(it.timestamp_utc).getTime() + ms).toISOString() : null,
}));
```

(Añadir `'#pdd': 'pdf_deleted_at'` a `LIST_PROJECTION` en `dynamo.aws.js`.)

### 11.4 Dejar rastro del borrado

**CloudTrail no registra los borrados por lifecycle**: los ejecuta S3
internamente, sin una identidad IAM que grabar. Para que el log diga cuándo
desapareció el archivo, el bucket avisa a la Lambda verificadora, que lo anota
en el ítem — y de ahí el stream lo copia al bucket WORM.

`infra/api/lambda.tf` — en `aws_s3_bucket_notification.pdfs`, un segundo bloque:

```hcl
  # Borrado por lifecycle (sección 11). `DeleteMarkerCreated` es el momento en
  # que el PDF deja de poder descargarse; el `Delete` definitivo llega un día
  # después.
  lambda_function {
    lambda_function_arn = aws_lambda_function.pdf_verifier.arn
    events              = ["s3:LifecycleExpiration:DeleteMarkerCreated"]
    filter_prefix       = "${local.platform.pdf_key_prefix}/"
    filter_suffix       = ".pdf"
  }
```

`src/handlers/pdfVerifier.js` — bifurcar por `record.eventName`:

```js
if (record.eventName.startsWith('LifecycleExpiration:')) {
  await markStoredPdfDeleted({ bucket, key, consentId, deletedAtIso: record.eventTime });
  continue;
}
```

`src/services/pdfUrlService.js`:

```js
export async function markStoredPdfDeleted({ key, consentId, deletedAtIso }) {
  const log = await findLog(consentId, null);
  if (!log) return { marked: false, reason: 'log_no_encontrado' };
  await dynamo.markPdfDeleted({ pk: log.PK, sk: log.SK, key, deletedAtIso });
  logger.info('PDF eliminado por lifecycle', { consent_id: consentId, key, deleted_at: deletedAtIso });
  return { marked: true };
}
```

`src/aws/dynamo.aws.js` (y stub):

```js
export async function markPdfDeleted({ pk, sk, key, deletedAtIso }) {
  await getDoc().send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET pdf_deleted_at = :t, pdf_deleted_key = :k',
      ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
      ExpressionAttributeValues: { ':t': deletedAtIso, ':k': key },
    }),
  );
}
```

El rol `verifier` ya tiene `dynamodb:UpdateItem`. La SCP permite `UpdateItem`
a los roles del propio servicio (solo lo deniega a los demás), así que esta
escritura pasa.

### 11.5 Cómo se ve en la web

- Columna **PDF**: `Verificado · expira en 12 días` (verde) / `Expirado` (gris) / `Pendiente` (ámbar).
- Botones deshabilitados con el motivo en el `title` cuando `pdf_deleted_at`
  existe o `pdf_expires_at` ya pasó.
- Forzar la petición devuelve `410` con el `message` explicando el plazo.

---

## 12. CloudTrail y las capas de inmutabilidad

### 12.1 Qué es CloudTrail y qué hace aquí

CloudTrail es la **caja negra de la cuenta de AWS**: registra cada llamada a
la API de AWS — quién (usuario o rol IAM), desde qué IP, cuándo, con qué
parámetros y con qué resultado — y la entrega como archivos JSON a un bucket.
**No impide nada.** Sirve para reconstruir qué pasó, quién lo hizo y detectar
si alguien intentó alterar la evidencia.

Está configurado en `infra/platform/audit_trail.tf` (`aws_cloudtrail.consent`):

| Selector | Qué graba | Ejemplo en este sistema |
| --- | --- | --- |
| **Eventos de gestión** | Cambios de configuración e IAM en toda la cuenta | "`terraform-deploy` cambió la política del bucket a las 14:02" · "alguien llamó a `StopLogging` sobre el trail y recibió AccessDenied" · "se creó una clave de acceso para el usuario `auditor`" |
| **Eventos de datos — tabla `consent_audit_logs`** | Cada `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `Scan`, `GetItem` sobre la tabla, con la identidad | "el rol `medical-consent-api` insertó `PATIENT#1018…` a las 20:15 desde 190.85.12.34" · "el usuario `auditor` hizo un `Scan` desde la consola" · "el rol `pdf-verifier` marcó `pdf_verified`" |
| **Eventos de datos — objetos del bucket de PDFs** | Cada `PutObject`, `GetObject`, `DeleteObject` | La subida por URL firmada aparece como **el rol de la Lambda** (quien firmó) con **la IP de la tablet** (quien envió). La descarga desde la web, igual, con la IP del auditor. |
| **Validación de archivos** (`enable_log_file_validation`) | Cada hora, un *digest* firmado con el hash de los archivos de la hora anterior, encadenado con el digest previo | `aws cloudtrail validate-logs --trail-arn … --start-time …` demuestra que ningún archivo del trail fue alterado ni borrado desde que se escribió |

Se entrega a `s3://<prefijo>medical-consent-audit-trail-<cuenta>/cloudtrail/`,
un bucket con **Object Lock a 365 días**: ni el propio CloudTrail puede
reescribir lo entregado. Tarda entre 5 y 15 minutos en aparecer; es un
registro forense, no una alerta en tiempo real.

Lo que CloudTrail **no** cubre y por eso existen las demás capas: no frena a
nadie; no registra los borrados por lifecycle de S3 (11.4); y un
administrador de la cuenta podría, en principio, pararlo — de ahí la SCP.

### 12.2 Las capas, de la más profunda a la más superficial

```
 +-------------------------------------------------------------------------+
 | 1. SCP (cuenta de gestion, infra/org)   frena a admins y a root         |
 |  +--------------------------------------------------------------------+ |
 |  | 2. Object Lock (WORM)   rastro 365 d - PDFs 30 d                   | |
 |  |  +---------------------------------------------------------------+ | |
 |  |  | 3. CloudTrail + digests firmados      quien hizo cada llamada | | |
 |  |  | 4. DynamoDB Streams -> Lambda -> WORM cada cambio de la tabla | | |
 |  |  | 5. Checksum firmado + verificador     el PDF es el que se dijo| | |
 |  |  | 6. Reglas de escritura del API        el log nace inmutable   | | |
 |  |  | 7. IAM minimo + estados separados     nadie tiene de mas      | | |
 |  |  | 8. KMS + access logs                  cifrado y trazabilidad  | | |
 |  |  +---------------------------------------------------------------+ | |
 |  +--------------------------------------------------------------------+ |
 +-------------------------------------------------------------------------+
```

| # | Capa | Dónde | Qué garantiza | Qué NO garantiza |
| --- | --- | --- | --- | --- |
| 1 | **SCP de AWS Organizations** | `infra/org/main.tf`, aplicada desde una **segunda cuenta** de gestión | Deniega a **toda** la cuenta de trabajo, incluido root: borrar/editar filas de la tabla (salvo los roles del servicio), borrar versiones, saltarse Object Lock, tocar versionado/lifecycle/cifrado de los buckets, parar o reconfigurar CloudTrail, borrar la clave KMS. Es la única construcción de AWS que frena a un administrador. | Requiere crear la organización (pasos en el propio archivo). **Hoy está escrita, no necesariamente aplicada.** |
| 2 | **S3 Object Lock (WORM)** | `platform/audit_trail.tf` (365 d), `platform/s3.tf` (30 d, sección 11) | Durante la retención nadie puede sobrescribir ni borrar la versión. En **COMPLIANCE** ni root ni AWS; en **GOVERNANCE** hace falta `s3:BypassGovernanceRetention`, que la SCP deniega. | Solo protege *versiones*; sin la SCP, un admin podría cambiar la regla para objetos futuros. Pasar a COMPLIANCE cuando el plazo esté confirmado. |
| 3 | **CloudTrail con validación** | 12.1 | Registro forense de cada llamada, con identidad e IP; digests encadenados que delatan alteraciones. | No impide; no ve lifecycle; 5–15 min de retraso. |
| 4 | **DynamoDB Streams → Lambda `audit-trail` → bucket WORM** | `infra/api/audit_trail.tf`, `src/handlers/auditTrail.js` | DynamoDB no tiene WORM. Cada INSERT/MODIFY/REMOVE (imagen anterior **y** nueva) se copia como objeto bloqueado con su propio SHA-256 que S3 verifica. Editar una fila no destruye evidencia: crea más. DLQ en SQS: ningún evento se pierde en silencio. | Si la DLQ acumula mensajes, hay un hueco: hace falta una alarma (abajo). |
| 5 | **Integridad del PDF** | `pdfUrlService.js`, `pdfVerifier.js`, `platform/s3.tf` | El SHA-256 va **firmado dentro de la URL de subida**: S3 rechaza con `BadDigest` cualquier cuerpo distinto; el verificador contrasta el checksum almacenado con el del log y marca `pdf_verified`. El hash del PDF queda en el log, en el rastro WORM y en CloudTrail. | El hash hace el documento *verificable*, no *irrefutable* frente a un tercero (abajo). |
| 6 | **Reglas de escritura del API** | `auditService.js`, `docs/API_CONTRACT.md` | `PutItem` condicional: un log se crea, nunca se actualiza. Llaves derivadas en el servidor. `operator_id` del token, no del cuerpo. IP del gateway, no de la tablet. `received_at` con el reloj del gateway. Los `ACCESS#` de la web se escriben antes de responder. | Protege contra un cliente mentiroso; no contra un admin de AWS (para eso 1–4). |
| 7 | **Mínimo privilegio** | `infra/api/iam.tf`, `platform/readonly_user.tf`, estados separados | Un rol por Lambda con solo sus acciones. Usuario `auditor` de solo lectura para el día a día; `terraform-deploy` solo para desplegar. `api/` no puede tocar los datos de `platform/`. Registro de usuarios cerrado. | Claves de acceso filtradas siguen siendo un riesgo: MFA en root y en `terraform-deploy`. |
| 8 | **Cifrado y trazabilidad de red** | `platform/kms.tf`, `api/api_gateway.tf` | CMK propia para tabla, stream y PDFs. Access logs del gateway 90 días con `userSub` y error del autorizador: los 401 que nunca llegan a la Lambda también dejan rastro. | — |

### 12.3 Lo que falta para cerrar el círculo

Todo esto ya está señalado en el repo; se lista aquí para que quede en un
solo sitio:

1. **Aplicar la SCP** (crear la cuenta de gestión y la organización). Sin ella,
   las capas 2–4 protegen contra errores y contra usuarios normales, pero no
   contra un administrador de la cuenta.
2. **COMPLIANCE** en el bucket del rastro cuando el plazo legal esté
   confirmado por quien responda por él (hoy GOVERNANCE, reversible).
3. **Alarma sobre la DLQ del rastro**: CloudWatch
   `ApproximateNumberOfMessagesVisible > 0` en
   `<prefijo>medical-consent-audit-trail-dlq` → SNS → correo. Un mensaje ahí
   es un cambio de la tabla que no llegó al WORM.
4. **`validate-logs` programado**: EventBridge semanal que ejecute
   `aws cloudtrail validate-logs` y avise si algún digest no cuadra.
5. **Sello de tiempo externo** si esto tiene que sostenerse en un litigio:
   RFC 3161 (TSA) o un digest firmado con KMS (`kms:Sign`, clave asimétrica)
   sobre `{pdf_sha256, timestamp_utc, consent_id}`, guardado en el log. Hoy el
   sistema demuestra que el PDF *no cambió*; con esto demuestra también
   *cuándo existía*, ante alguien que no confíe en tu cuenta de AWS.
6. **MFA** en root y en `terraform-deploy`; rotación de la clave de `auditor`.

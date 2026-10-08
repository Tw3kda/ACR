# Contrato del API gateway

Qué recibe cada Lambda, qué hace con ello y a qué servicios llama. La app ya emite estas
peticiones exactamente con esta forma: mientras `EXPO_PUBLIC_API_URL` esté vacío las
imprime en consola en vez de enviarlas (ver `docs/SETUP.md`), así que el payload de abajo
se puede contrastar con el que aparece en el log de Metro antes de desplegar nada.

## Registro de auditoría en S3

> **Almacenamiento (2026-09-21).** El log ya no se guarda como ítem de DynamoDB. El
> backend lo escribe como `events/<consent_id>/0001-CONSENT_SIGNED.json` en un bucket
> con Object Lock (365 días), una sola vez por `consent_id` (`If-None-Match: *`), y el
> mismo API añade `0002-PDF_VERIFIED.json` encadenado por hash. Los campos `PK`, `SK`
> y `GSI*` que la app aún envía se ignoran. **Respuesta nueva:** `409` si llega otro
> log distinto bajo un `consent_id` ya usado — el id es la clave del objeto, por eso
> la app genera ahora `CONS-AAAA-MMDD-<10 hex>`. Ver `docs/PLAN_S3_COMPLIANCE.md`.
>
> **Flujo (2026-09-21):** una sola llamada, `POST /consents`, con log y PDF. Ya no existen
> `POST /consents/{id}/pdf-url`, la subida directa a S3 ni el Lambda verificador (§4).

## Arquitectura

```
App (Expo, tablet)
  │
  ├── POST /auth/login ──────┐
  ├── POST /auth/register ───┤
  ├── POST /auth/refresh ────┼──> API Gateway (HTTP API) ──> Lambda ──┬──> Cognito
  ├── POST /consents ────────┤        (log + PDF en base64)           ├──> S3 pdfs      (PutObject, checksum, write-once)
  └── POST /audit/logs ──────┘                                        └──> S3 evidence  (0001, 0002, punteros)
```

El PDF viaja **dentro** de `POST /consents`, en base64. Un consentimiento de una página son
~150 KB (~200 KB de cuerpo); el límite es 4 MB de PDF. El Lambda comprueba el hash, guarda
el PDF con verificación de checksum de S3 y escribe los dos eventos de evidencia en la
misma petición. No hay URL firmada, subida directa ni verificación asíncrona: la respuesta
es la verificación.

## Convenciones comunes

**Integración:** Lambda proxy, payload format 2.0 (HTTP API). El cuerpo llega como
**string** en `event.body` — hay que `JSON.parse`. La respuesta también debe llevar `body`
como string; devolver un objeto suelto produce un 502 sin traza útil.

**Cabeceras que envía la app:**

| Cabecera | Cuándo |
| --- | --- |
| `Content-Type: application/json` | siempre |
| `x-api-key` | si se define `EXPO_PUBLIC_API_KEY` |
| `Authorization: Bearer <token>` | en cuanto hay sesión — incluida la llamada de auditoría |

**Autorización:** poner un **JWT authorizer** de Cognito en las rutas `/audit/*` y
`/consents/*`; las de `/auth/*` van sin autorizador. Con el authorizer, el Lambda recibe las
claims en `event.requestContext.authorizer.jwt.claims` y no necesita validar el token a mano.

**Rutas configurables.** La app no tiene ninguna ruta escrita en el código: todas salen de
variables de entorno, así que si el gateway expone otros caminos basta cambiar el `.env`.

| Variable | Valor por defecto |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | *(vacío = modo dry-run)* |
| `EXPO_PUBLIC_AUTH_LOGIN_PATH` | `/auth/login` |
| `EXPO_PUBLIC_AUTH_REGISTER_PATH` | `/auth/register` |
| `EXPO_PUBLIC_AUTH_REFRESH_PATH` | `/auth/refresh` |
| `EXPO_PUBLIC_CONSENTS_PATH` | `/consents` |
| `EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS` | `12` |

**Token expirado: devolver `401`, no `403`.** La app intercepta el 401, renueva la sesión y
**reintenta la petición una sola vez** de forma transparente. Un `403` no dispara esa lógica
y el usuario ve un error. Reservar el 403 para permisos insuficientes de verdad.

**Formato de error — obligatorio.** La app lee `response.data.message` y se lo muestra al
usuario tal cual:

```json
{ "message": "Correo o contraseña incorrectos" }
```

Un 4xx se toma como respuesta definitiva del backend: la app **no** reintenta contra su
SQLite local. Solo un endpoint ausente o inalcanzable dispara el fallback local.

**CORS:** solo hace falta para `expo start --web` durante el desarrollo. Permitir `POST` y
`OPTIONS`, origen `http://localhost:8081`, cabeceras `content-type, authorization,
x-api-key`. En Android/iOS no aplica, lo que hace muy confuso el síntoma: falla en el
navegador y funciona en la tablet.

---

## 1. `POST /auth/login`

### Recibe

```json
{ "email": "profesional@acrvitallaboral.com", "password": "..." }
```

El correo llega recortado y en minúsculas.

### Hace

1. `AdminInitiateAuth` contra Cognito con `AuthFlow: ADMIN_USER_PASSWORD_AUTH` (requiere
   `ALLOW_ADMIN_USER_PASSWORD_AUTH` en el app client). Se usa la variante `Admin` porque
   quien llama es el Lambda, no el dispositivo.
2. Si el app client tiene secreto, calcular `SECRET_HASH` =
   `base64(HMAC-SHA256(username + clientId, clientSecret))`. Omitirlo devuelve un
   `NotAuthorizedException` engañoso que parece contraseña mala.
3. Decodificar el `IdToken` recién emitido para sacar `sub`, `email` y `name` (no hace falta
   verificar la firma: lo acaba de emitir Cognito). Alternativa: `AdminGetUser`.

### Devuelve

```json
{
  "token": "eyJraWQ...",
  "refreshToken": "eyJjdHkiOiJKV1Qi...",
  "user": {
    "id": "9f3b2a1c-5d4e-4f6a-9b8c-1e2f3a4b5c6d",
    "email": "profesional@acrvitallaboral.com",
    "name": "Dra. Ana Ruiz"
  }
}
```

Sin `refreshToken` la sesión dura lo que dure el token y termina en un login manual: la app
lo guarda y renueva sola con él (sección 3). Acepta también `refresh_token`.

`token` debe ser el token que el JWT authorizer espera después (**access token** si el
authorizer valida access tokens). La app lo guarda y lo manda como `Bearer` en todo lo
demás. El cliente también acepta `accessToken` o `idToken` como nombre del campo, y el
usuario plano en vez de anidado — ver `normalizeAuthResponse` en
`features/auth/services/authApi.ts`.

### Errores

| Situación | Código | `message` |
| --- | --- | --- |
| `NotAuthorizedException` / `UserNotFoundException` | 401 | `Correo o contraseña incorrectos` |
| `PasswordResetRequiredException` | 403 | `Debe restablecer su contraseña` |
| `UserNotConfirmedException` | 403 | `La cuenta aún no está confirmada` |

> Devolver el mismo mensaje para usuario inexistente y para contraseña mala; distinguirlos
> permite enumerar cuentas.

---

## 2. `POST /auth/register`

### Recibe

```json
{ "email": "nuevo@acrvitallaboral.com", "password": "...", "name": "Ana Ruiz" }
```

### Hace

1. `AdminCreateUser` (o `SignUp`) con el atributo `name`.
2. `AdminSetUserPassword` con `Permanent: true`.
3. `AdminInitiateAuth` para devolver una sesión ya iniciada.

### Devuelve

Lo mismo que `/auth/login`.

> **Decidido: sin confirmación por correo.** El usuario queda confirmado en el mismo `POST`
> y la respuesta trae la sesión ya iniciada, que es lo que la app espera —
> `useRegister.ts` inicia sesión de inmediato con el token que recibe. De ahí los tres pasos
> de arriba (`AdminCreateUser` → `AdminSetUserPassword` con `Permanent: true` →
> `AdminInitiateAuth`) y **no** `SignUp` con verificación.
>
> Si más adelante se decide que el personal clínico no debe auto-registrarse, se crean los
> usuarios desde la consola y se quita la pantalla; la app no necesita más cambios.

---

## 3. `POST /auth/refresh`

La app renueva la sesión sola: al 90 % de `EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS` (10,8 h con el
valor de 12), cada vez que vuelve al primer plano, y ante cualquier `401`. Las renovaciones
simultáneas se agrupan en una sola petición, así que este endpoint no recibe ráfagas.

### Recibe

```json
{ "refresh_token": "eyJjdHkiOiJKV1Qi..." }
```

### Hace

`AdminInitiateAuth` con `AuthFlow: REFRESH_TOKEN_AUTH` y
`AuthParameters: { REFRESH_TOKEN: <token>, SECRET_HASH: <si el client tiene secreto> }`.

### Devuelve

```json
{ "token": "eyJraWQ...", "refreshToken": "eyJjdHkiOiJKV1Qi..." }
```

`refreshToken` es opcional: si no viene, la app conserva el que ya tenía — que es el
comportamiento normal de Cognito salvo que se active la rotación.

### Errores

Cualquier fallo aquí **cierra la sesión** en la app y devuelve al usuario al login. Responder
`401` con `{"message":"La sesión expiró, vuelva a iniciar sesión"}`.

---

## 4. `POST /consents`

**La ruta de la firma.** El log `CONSENT_SIGNED` y el PDF entran juntos, en una petición;
salen registrados y verificados, o no salen. Sustituye (desde 2026-09-21) a las tres
llamadas anteriores — `POST /audit/logs`, `POST /consents/{id}/pdf-url`, `PUT` a S3 — y al
Lambda verificador asíncrono. La app lo implementa en
`features/consent/services/consentSubmitService.ts`.

### Recibe

```json
{
  "log": { ...el ítem CONSENT_SIGNED completo, tal como lo arma auditLogBuilder.ts... },
  "pdf_base64": "JVBERi0xLjQK..."
}
```

- `log.signature_data.pdf_sha256` es obligatorio (64 hex): es el compromiso que hizo el
  dispositivo sobre los bytes exactos del documento.
- `log.template = { code, version, title, exam_type }`: el formulario firmado. El servidor lo
  comprueba contra las plantillas publicadas y añade al evento `template_ref`
  (`verified`, `sha256` de la plantilla guardada). Una plantilla no publicada **no** rechaza
  el consentimiento: queda `verified: false`.
- `pdf_base64`: el PDF entero. Máximo 4 MB de PDF (~5.4 MB de cuerpo; Lambda corta en 6 MB
  por invocación síncrona). Un consentimiento de una página pesa ~150 KB.

### Hace

1. Valida el log igual que antes; exige `event_type = CONSENT_SIGNED`.
2. Decodifica el PDF, comprueba que empieza por `%PDF-`, calcula su SHA-256 y lo compara con
   `pdf_sha256`. **Si no coincide, `400 pdf_hash_mismatch` y no se escribe nada.**
3. `PutObject` del PDF en `consents/AAAA/MM/<consent_id>.pdf` con `ChecksumSHA256` (S3
   vuelve a verificar) e `If-None-Match: *`. Si ya existía con el mismo checksum es un
   reintento y sigue; con otro, `409 pdf_conflict`.
4. Escribe `events/<id>/0001-CONSENT_SIGNED.json` con `operator_id`, `ip_address`,
   `received_at_utc` y **la clave real del PDF** en `capture_metadata.pdf_s3_key` (lo que
   envió la app era una predicción). Mismo `log_id` ya escrito = reenvío; otro = `409`.
5. Escribe `events/<id>/0002-PDF_VERIFIED.json` con `prev_hash = sha256(bytes de 0001)` y el
   checksum que S3 registró.
6. Escribe los tres punteros del índice.

El orden está pensado para que un reintento termine lo que un fallo dejó a medias: cada
paso es idempotente por `If-None-Match`.

### Devuelve

`201`:

```json
{
  "consent_id": "CONS-2026-0921-a1b2c3d4e5",
  "log_id": "…",
  "pdf": { "bucket": "medical-consent-pdfs-…", "key": "consents/2026/09/CONS-….pdf", "sha256": "…", "size_bytes": 148211 },
  "events": { "signed_sha256": "…", "verified_sha256": "…" }
}
```

`200` con `"duplicate": true` y el mismo cuerpo si ya estaba registrado (reenvío del outbox).

### Errores

| Código | `code` | Cuándo |
|---|---|---|
| 400 | `bad_request` | log inválido, `pdf_base64` ausente, no es un PDF, `event_type` distinto |
| 400 | `pdf_hash_mismatch` | el PDF no es el que el log dice |
| 409 | `conflict` | otro log bajo el mismo `consent_id` |
| 409 | `pdf_conflict` | otro PDF bajo el mismo `consent_id` |
| 413 | `payload_too_large` | PDF > 4 MB o biometría > 20 000 puntos |

Toda respuesta de error trae `{ "message", "code" }`. La app trata 4xx (salvo 401/408/429)
como definitivos: no reintenta, guarda el consentimiento en `outbox/rejected/` del
dispositivo para inspección.

### Reintentos

La app guarda **en disco** (`<documentos>/outbox/<consent_id>.json`, log + PDF) lo que no
pudo entregar, y lo reintenta al abrir la app, al volver a primer plano y al enviar el
siguiente. **El mismo consentimiento puede llegar varias veces**; por eso cada escritura es
`If-None-Match` y el reenvío responde `200 duplicate`.

---

## 5. `POST /audit/logs`

Solo para eventos que **no** son una firma (`CONSENT_VIEWED`, `CONSENT_DECLINED`,
`CONSENT_REVOKED`). Un `CONSENT_SIGNED` aquí responde `400`: una firma sin su documento no
es un consentimiento. La app hoy no envía ninguno de estos; la ruta queda por contrato.

Recibe el ítem tal cual, lo valida igual y lo escribe como `events/<id>/0001-<tipo>.json`.
`201 { log_id }`; reenvío `200 { log_id, duplicate: true }`; otro log bajo el mismo id `409`.

---

## 6. `GET /templates` y `GET /templates/{code}`

Los formularios de consentimiento. Se publican con `API GATEWAY/scripts/publish-template.mjs`
(guía en `API GATEWAY/docs/PLANTILLAS.md`); la app los descarga en
`features/consent/services/consentRepository.ts`. Requieren sesión (cualquier usuario: el
profesional de la tablet no es auditor).

`GET /templates` → `200`:

```json
{
  "updated_at_utc": "2026-10-06T02:18:27.175Z",
  "templates": [
    { "code": "CA-F-14", "version": "1.0", "title": "…", "examType": "TOMA_DE_MUESTRAS",
      "effectiveDate": "2023-01-09", "sha256": "44626cf3…" }
  ]
}
```

`GET /templates/{code}` → la versión activa; `?version=1.0` → esa versión exacta, activa o no
(una versión publicada no cambia nunca: la app la cachea y no la vuelve a pedir).

```json
{ "template": { "code": "CA-F-14", "version": "1.0", "blocks": [ … ], "fields": [ … ], … }, "sha256": "44626cf3…" }
```

`404` si no hay versión activa o no existe esa versión. Sin red, la app usa la última lista
descargada y, si nunca la tuvo, el CA-F-14 incluido en el APK.

---

## Recursos

### DynamoDB

| | |
| --- | --- |
| Tabla | `consent_audit_logs`, on-demand |
| PK / SK | `PATIENT#<cedula>` / `LOG#<iso>#<consent_id>` |
| GSI1 | `CLINIC#<sede>` / `LOG#<iso>` |
| Proyección GSI1 | `INCLUDE`: `consent_id`, `event_type`, `subject`, `capture_metadata` |

La proyección deja fuera `biometrics_json` a propósito: es el 90% del ítem y no se consulta
al listar por sede. (Las proyecciones de un GSI solo admiten atributos de primer nivel, no
rutas anidadas.)

Con `@aws-sdk/lib-dynamodb` el JSON entra tal cual: los objetos anidados se vuelven Map, los
arreglos List, `ip_address: null` un NULL. No hace falta marshalling manual.

**Límite de 400 KB por ítem.** Una firma de 5 s a 60 Hz ronda los 25 KB; harían falta unos
8.000 puntos para chocar. Si algún día crece (consentimientos multipágina, más firmantes),
mover `biometrics_json` a S3 y dejar un puntero en el ítem.

### S3

- Bucket con **versionado + Object Lock (WORM)**. Object Lock hay que habilitarlo **al crear
  el bucket**; no se puede activar después.
- Cifrado en reposo con KMS.
- Bloquear todo acceso público: el único camino de escritura es la URL firmada.
- Retención: definirla según la normativa aplicable a historia clínica **antes** de
  configurar cualquier regla de lifecycle. No poner expiración "por defecto".

### Cognito

- User pool con `email` como alias de inicio de sesión y atributo `name`.
- App client **con** secreto (lo consume el Lambda, no el dispositivo) y
  `ALLOW_ADMIN_USER_PASSWORD_AUTH`.
- **Vigencia del access token: 12 horas**, para cubrir una jornada completa. Hay que
  configurarla en el app client *y* dejar `EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS=12` en el
  `.env`: la app usa ese valor para decidir cuándo renovar por adelantado. Si las dos no
  coinciden, renueva tarde y el usuario se topa con un 401 — del que se recupera solo, pero
  con una petición perdida de por medio.
- Refresh token con vigencia mayor (30 días es lo habitual). Si se activa la rotación,
  devolver el nuevo en cada `/auth/refresh`: la app lo guarda y usa el último que recibió.

### IAM por ruta

| Ruta | Permisos |
| --- | --- |
| `/auth/login`, `/auth/refresh` | `cognito-idp:AdminInitiateAuth` |
| `/auth/register` | `cognito-idp:AdminCreateUser`, `AdminSetUserPassword`, `AdminInitiateAuth` |
| `/consents` | `s3:PutObject`, `GetObject`, `GetObjectAttributes` sobre `pdfs/consents/*`; `s3:PutObject` sobre `evidence/events/*` e `index/*`; `GetObject`/`ListBucket` en evidence |
| `/audit/logs` | los mismos de evidence |

---

## Pendientes

Del lado de la app:

- Persistir el outbox de auditoría en SQLite: hoy vive en memoria y se pierde al reiniciar.
  Falta además llamar a `flushPendingAuditLogs()` al arrancar y después de un login.
- Reintentar la subida del PDF igual que el log. Si la subida falla, hoy el documento se
  queda solo en la caché del dispositivo.
- Persistir la sesión (`expo-secure-store`) para que un reinicio a media jornada no obligue a
  iniciar sesión otra vez.
- Probar en tablet con lápiz: la biometría de presión y la subida del archivo se han
  verificado contra servidores simulados, no sobre hardware real.

Del lado del backend:
- Si esto tiene que sostenerse en un litigio: sello de tiempo RFC 3161 o digest firmado con
  KMS sobre `{pdf_sha256, timestamp, consent_id}`. El hash hace el documento *verificable*;
  no lo hace irrefutable por sí solo.

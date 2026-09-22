# API de consentimiento informado — implementación

> **Estado (2026-09-21): el registro de auditoría ya NO vive en DynamoDB.** Este
> documento describe el diseño anterior. La verdad es ahora S3 con Object Lock —
> eventos inmutables `events/<consent_id>/000N-*.json` más punteros de índice — y
> DynamoDB, su stream, el Lambda del rastro y la clave KMS se eliminaron. El diseño
> vigente está en `docs/PLAN_S3_COMPLIANCE.md` (ejecutado) y en `docs/API_CONTRACT.md`.

Implementación en **Express 5 sobre Lambda**, detrás de un **API Gateway HTTP API
(payload 2.0)**, del contrato descrito en [`API_CONTRACT.md`](API_CONTRACT.md).

> Las recomendaciones priorizadas, el plan de acción por fases y los diagramas de
> comunicación están en [`RECOMENDACIONES_Y_PLAN.md`](RECOMENDACIONES_Y_PLAN.md).

Los servicios de AWS todavía no existen. Por eso cada uno de ellos tiene dos
implementaciones intercambiables por variable de entorno —la real con el SDK v3 y
una simulada en memoria— y el API arranca y responde el contrato completo sin
ninguna credencial. **Cuando la infraestructura esté creada no hay que tocar
código: solo rellenar el `.env`.**

---

## 1. Arranque rápido

```bash
npm install
npm start          # http://localhost:3000  (todo simulado)
npm run smoke      # recorre el flujo completo contra el handler de Lambda
```

O en contenedor, sin instalar nada:

```bash
docker build -t acr-api . && docker run --rm -p 3000:3000 acr-api
```

Usuario de prueba precargado en el Cognito simulado: `demo@acrvitallaboral.com` /
`Demo1234!` (configurable con `STUB_SEED_*`).

Para conectar la app: `EXPO_PUBLIC_API_URL=http://localhost:3000` en su `.env`.

```bash
curl -s http://localhost:3000/health
```

`/health` devuelve qué adaptador está activo en cada servicio, que es la forma
rápida de saber si se está escribiendo en AWS o en memoria:

```json
{
  "status": "ok",
  "drivers": { "cognito": "stub", "dynamodb": "stub", "s3": "stub" },
  "stubbed": ["cognito", "dynamodb", "s3"]
}
```

---

## 2. Estructura

```
src/
  handlers/
    api.js              Handler del Lambda del gateway (adaptador event 2.0 -> Express)
    pdfVerifier.js      Handler del Lambda disparado por s3:ObjectCreated (sección 6)
  local.js              Servidor HTTP normal para desarrollo
  app.js                Ensamblado de Express: middlewares + rutas
  config/env.js         Único punto donde se lee process.env
  routes/               auth · audit · consents (rutas finas, sin lógica)
  services/             authService · auditService · pdfUrlService (la lógica)
  aws/
    index.js            Selector de adaptador según las variables de entorno
    cognito.aws.js  / cognito.stub.js
    dynamo.aws.js   / dynamo.stub.js
    s3.aws.js       / s3.stub.js
  middleware/           requestContext · auth · cors · errorHandler
  lib/                  errores, logger con redacción, validación, JWT, SECRET_HASH
scripts/smoke.js        Prueba de humo end-to-end (33 comprobaciones)
```

Las rutas no saben nada de AWS y los servicios no saben nada de HTTP. El único
sitio que lee `process.env` es `config/env.js`.

### Los dos handlers

| Handler | Disparador | Función |
| --- | --- | --- |
| `src/handlers/api.js` | API Gateway HTTP API | Las cinco rutas del contrato |
| `src/handlers/pdfVerifier.js` | `s3:ObjectCreated:*` sobre `consents/` | Marca `pdf_verified` |

En Lambda: runtime `nodejs22.x`, handler `src/handlers/api.handler` y
`src/handlers/pdfVerifier.handler` respectivamente.

---

## 3. El modelo de adaptadores

Cada servicio de AWS se resuelve una sola vez, en el arranque en frío:

| Servicio | Pasa a `aws` cuando… | Forzar a mano |
| --- | --- | --- |
| Cognito | hay `COGNITO_USER_POOL_ID` **y** `COGNITO_CLIENT_ID` | `COGNITO_DRIVER=aws\|stub` |
| DynamoDB | hay `AUDIT_TABLE_NAME` | `DYNAMODB_DRIVER=aws\|stub` |
| S3 | hay `PDF_BUCKET` | `S3_DRIVER=aws\|stub` |

Los adaptadores simulados guardan todo en memoria y se pierden en cada arranque
en frío. Un API de auditoría que responde `201` sin escribir nada es peor que un
API caído, así que **el proceso se niega a arrancar con `NODE_ENV=production` y
algún adaptador simulado** (`assertDeployable()`); la salida de emergencia es
`ALLOW_STUB_IN_PRODUCTION=true`, explícita y registrada.

### Traza de consola mientras no haya AWS

Con algún adaptador simulado, cada petición imprime tres bloques: lo que llegó,
la llamada que se hará a AWS cuando el recurso exista, y lo que se respondió.

```
────────────────────────────────────────────────────────────────────────
▶ RECIBIDO  POST /auth/login  #36090e64  ip 190.85.12.34
cabeceras:
{ "content-type": "application/json", "x-api-key": "«oculto»" }
cuerpo:
{ "email": "demo@acrvitallaboral.com", "password": "«oculto»" }
☁ AWS (simulado) Cognito.AdminInitiateAuth  — ADMIN_USER_PASSWORD_AUTH
  entrada:
{ "UserPoolId": "«COGNITO_USER_POOL_ID sin definir»", ... }
◀ ENVIADO   200 POST /auth/login  #36090e64  7 ms
cuerpo:
{ "token": "eyJhbGciOiJu…fiable (491 car.)", "user": { ... } }
────────────────────────────────────────────────────────────────────────
```

Sirve para contrastar el payload contra el que la app imprime en el log de Metro.

| Variable | Efecto |
| --- | --- |
| `TRACE_IO` | Encender o apagar a mano (por defecto: encendido si hay algún stub) |
| `TRACE_FULL=true` | Sin recortar: imprime los miles de puntos de la biometría |
| `TRACE_REDACT=false` | Imprime contraseñas y tokens completos. **Solo en local** |
| `TRACE_BODY_MAX_CHARS` | Corte por cuerpo (4000 por defecto) |

En producción con AWS real queda apagado: volcar cuerpos completos en CloudWatch
es un problema de privacidad, no una ayuda. Ahí el que sirve es el logger
estructurado, que redacta contraseñas, tokens, biometría y URLs firmadas.

---

## 4. Endpoints

Todas las respuestas de error llevan exactamente `{ "message": "..." }`, en
español y listo para mostrar al usuario tal cual.

### 4.1 `POST /auth/login`

**Recibe** `{ "email": "...", "password": "..." }` · sin autorizador.

**Devuelve `200`**

```json
{
  "token": "eyJraWQ...",
  "refreshToken": "v1.eyJ1IjoiLi4u...",
  "expiresIn": 43200,
  "user": { "id": "9f3b...", "email": "...", "name": "Dra. Ana Ruiz" }
}
```

`token` es el **access token** por defecto (`COGNITO_TOKEN_FOR_APP=access`),
porque es lo que valida un JWT authorizer de HTTP API configurado sobre access
tokens. Si el authorizer se configura sobre el IdToken, cambie la variable a
`id`: **las dos cosas tienen que decir lo mismo o toda ruta protegida dará 401.**

| Situación | Código | `message` |
| --- | --- | --- |
| Credenciales malas o usuario inexistente | `401` | `Correo o contraseña incorrectos` |
| `PasswordResetRequiredException` | `403` | `Debe restablecer su contraseña` |
| `UserNotConfirmedException` | `403` | `La cuenta aún no está confirmada` |
| Reto pendiente (MFA, cambio de clave) | `403` | `La cuenta requiere un paso adicional de verificación` |
| Cognito con throttling | `429` | `Demasiados intentos, espere un momento` |

El mensaje es idéntico para contraseña mala y para usuario inexistente —
distinguirlos permite enumerar cuentas del personal clínico. Un formato de correo
inválido también sale como `401` por lo mismo, no como `400`.

### 4.2 `POST /auth/register`

**Recibe** `{ "email", "password", "name", "invite_code"? }` · **deshabilitado por
defecto** (ver Hallazgo 3).

Con `REGISTRATION_ENABLED=true` hace `AdminCreateUser` (`MessageAction: SUPPRESS`,
`email_verified: true`) → `AdminSetUserPassword` con `Permanent: true` →
`AdminInitiateAuth`, y responde `201` con la misma forma que el login: sesión ya
iniciada, sin confirmación por correo.

| Situación | Código | `message` |
| --- | --- | --- |
| Registro deshabilitado | `403` | `El registro de usuarios está deshabilitado…` |
| `REGISTRATION_INVITE_CODE` definido y no coincide | `403` | `Código de invitación inválido` |
| Correo ya registrado | `409` | `Ya existe una cuenta con ese correo` |
| Contraseña corta o fuera de política | `400` | mensaje concreto |

### 4.3 `POST /auth/refresh`

**Recibe** `{ "refresh_token": "..." }` (también acepta `refreshToken`) · sin
autorizador.

**Devuelve `200`** `{ "token": "...", "refreshToken": "..."?, "expiresIn": 43200 }`.
El `refreshToken` solo aparece si Cognito rota; si no viene, la app conserva el
que tenía.

**Cualquier fallo devuelve `401`** con `La sesión expiró, vuelva a iniciar sesión`
— nunca `403`, porque un `403` no dispara la lógica de renovación de la app y el
usuario vería un error.

### 4.4 `POST /audit/logs`

**Recibe** el ítem completo de `CONSENT_SIGNED` · **requiere JWT authorizer**.

Lo que el dispositivo **no** decide se sobrescribe en el servidor:

| Campo | Origen real |
| --- | --- |
| `device_context.ip_address` | `requestContext.http.sourceIp` |
| `capture_metadata.operator_id` | `claims.sub` del token |
| `received_at_utc` | `requestContext.timeEpoch` (reloj del gateway) |
| `pdf_verified` | siempre `false`; lo cambia el verificador de S3 |
| `PK`, `SK`, `GSI1_*`, `GSI2_*` | recalculados por el servidor (ver abajo) |

**Validaciones:** `consent_id` sin caracteres especiales, `event_type` dentro de
`AUDIT_ALLOWED_EVENT_TYPES`, `timestamp_utc` ISO-8601 UTC, `subject.patient_id`
presente, y todos los `*_sha256` de 64 hex (o vacíos, que es el caso web sin
archivo). También se cuenta el número de puntos biométricos para no chocar contra
el límite de 400 KB por ítem de DynamoDB.

**Política de llaves** (`AUDIT_KEY_POLICY`, por defecto `derive`): las llaves se
calculan en el servidor a partir del propio contenido —
`PK = PATIENT#<subject.patient_id>`, `SK = LOG#<timestamp_utc>#<consent_id>`.
Además de cerrar la puerta a que un dispositivo autenticado escriba en la
partición de otro paciente, es determinista: el mismo log reenviado produce las
mismas llaves y la idempotencia sigue funcionando. Si difieren de las enviadas se
registra un `warn`. Alternativas: `validate` (rechaza con `400` en vez de
recalcular) y `trust` (usa las del cliente; no recomendado).

**Respuestas**

| Situación | Código | Cuerpo |
| --- | --- | --- |
| Creado | `201` | `{ "log_id": "..." }` |
| Reenvío del outbox (ya existía) | `200` | `{ "log_id": "...", "duplicate": true }` |
| Validación | `400` | `{ "message": "..." }` |
| Sin claims del authorizer | `401` | `La sesión expiró, vuelva a iniciar sesión` |
| Biometría desmedida | `413` | `La firma biométrica excede el tamaño permitido` |

> El contrato dice `ConditionalCheckFailedException → 409` en el texto, pero su
> propio ejemplo de código devuelve `200 { duplicate: true }`. Aquí se sigue el
> código: la app trata **cualquier 4xx como respuesta definitiva** y mostraría un
> error al usuario por un reenvío que en realidad fue un éxito. Ver Hallazgo 5.

### 4.5 `POST /consents/{consent_id}/pdf-url`

**Recibe** `{ "pdf_sha256": "...", "content_length": 384512 }` · **requiere JWT
authorizer**.

1. Busca el log del consentimiento (GSI `CONSENT#<id>`; si el cuerpo trae
   `patient_id` opcional, resuelve por la llave principal y se ahorra el índice).
2. Compara `pdf_sha256` con el `signature_data.pdf_sha256` ya registrado.
3. Convierte el hash **de hex a base64** (`Buffer.from(hex,'hex').toString('base64')`).
4. Firma un `PutObjectCommand` con el checksum **dentro de la firma**, sobre una
   clave construida por el servidor.
5. Corrige `capture_metadata.pdf_s3_key` en el log con la clave real.

**Devuelve `200`**

```json
{
  "url": "https://bucket.s3.amazonaws.com/consents/2026/08/CONS-2026-0831-042.pdf?X-Amz-...",
  "method": "PUT",
  "expires_in": 300,
  "headers": {
    "Content-Type": "application/pdf",
    "x-amz-checksum-sha256": "EZRiu3jrJApl..."
  }
}
```

La app debe enviar **exactamente** esas cabeceras en el `PUT` o la firma no
valida.

| Situación | Código | `message` |
| --- | --- | --- |
| `pdf_sha256` no es 64 hex, o falta `content_length` | `400` | mensaje concreto |
| No hay log para ese `consent_id` | `404` | `No existe un registro de auditoría para este consentimiento` |
| El hash no coincide con el registrado | `409` | `El documento no corresponde con el registro de auditoría` |
| Supera `PDF_MAX_BYTES` | `413` | `El documento excede el tamaño máximo permitido` |

**La clave de S3 la construye el servidor**, siempre:
`<PDF_KEY_PREFIX>/<AAAA>/<MM>/<consent_id>.pdf`, con año y mes tomados del
`timestamp_utc` del log. El `pdf_s3_key` que viene en el cuerpo del log es una
predicción hecha antes de que la clave existiera; aceptarla tal cual permitiría
firmar una escritura sobre cualquier ruta del bucket. El `consent_id` se valida
contra `^[A-Za-z0-9._-]{1,128}$` antes de entrar en la clave.

### 4.6 Verificador de S3

`src/handlers/pdfVerifier.js`, disparado por `s3:ObjectCreated:*` sobre
`consents/`: `GetObjectAttributes` → checksum de base64 a hex → comparación con
`signature_data.pdf_sha256` → `UpdateItem` con `pdf_verified`, `pdf_size_bytes`,
`pdf_checksum_sha256` y `pdf_verified_at`.

Un objeto sin checksum SHA-256 se marca como **no verificado** y se registra un
`warn`: significa que llegó por una vía que no exigía firma con checksum, y eso
es un problema de configuración, no un simple "no cuadra".

---

## 5. Variables de entorno

La lista completa y comentada está en [`.env.example`](../.env.example). Las que
importan para pasar a AWS real:

| Bloque | Variables |
| --- | --- |
| **Cognito** | `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_TOKEN_FOR_APP`, `COGNITO_REFRESH_USERNAME_MODE`, `REGISTRATION_ENABLED` |
| **DynamoDB** | `AUDIT_TABLE_NAME`, `AUDIT_CONSENT_INDEX_NAME`, `AUDIT_KEY_POLICY`, `AUDIT_ALLOWED_EVENT_TYPES` |
| **S3** | `PDF_BUCKET`, `PDF_KEY_PREFIX`, `PDF_URL_TTL_SECONDS`, `PDF_MAX_BYTES`, `PDF_SIGN_CONTENT_LENGTH`, `PDF_SSE_KMS_KEY_ID` |
| **Gateway** | `API_STAGE_PREFIX`, `JSON_BODY_LIMIT`, `AUTH_CLAIMS_SOURCE`, `CORS_*` |
| **Rutas** | `PATH_AUTH_LOGIN`, `PATH_AUTH_REGISTER`, `PATH_AUTH_REFRESH`, `PATH_AUDIT_LOGS`, `PATH_PDF_UPLOAD_URL` |

Las rutas son configurables en los dos lados: si el gateway expone otros caminos,
se cambian aquí y en el `.env` de la app sin tocar código en ninguno de los dos.

`COGNITO_CLIENT_SECRET` y `PDF_SSE_KMS_KEY_ID` deben venir de Secrets Manager o
Parameter Store, no de un `.env` en el repositorio.

---

## 6. Hallazgos: arquitectura y seguridad

Ordenados por lo que hay que resolver antes de desplegar.

### Hallazgo 1 — No hay forma de buscar un log por `consent_id` (bloqueante)

`/consents/{consent_id}/pdf-url` tiene que localizar el log de ese
consentimiento, pero el modelo del contrato no lo permite: la llave principal es
`PATIENT#<cédula>` / `LOG#<iso>#<consent_id>` y el único GSI es
`CLINIC#<sede>` / `LOG#<iso>`. Con `consent_id` a secas solo queda un `Scan` de
toda la tabla, que no es una opción.

**Resuelto en el código** añadiendo a cada ítem `GSI2_PK = CONSENT#<consent_id>`
y `GSI2_SK = LOG#<iso>`, y consultando ese índice. **Falta crear el GSI en la
tabla** (`AUDIT_CONSENT_INDEX_NAME`, por defecto `GSI2`), con proyección
`INCLUDE` de `PK`, `SK`, `consent_id`, `signature_data`, `timestamp_utc` — sin
`biometrics_json`, que es el 90 % del ítem.

Alternativa sin índice nuevo: que la app envíe `patient_id` en el cuerpo del
`pdf-url`. El código ya lo acepta como campo opcional y resuelve por la llave
principal cuando llega. Es más barato, pero obliga a tocar la app.

### Hallazgo 2 — `SECRET_HASH` en el refresh necesita el username, que la app no envía (bloqueante)

Con un app client **con secreto**, `REFRESH_TOKEN_AUTH` exige `SECRET_HASH`, y
`SECRET_HASH = base64(HMAC-SHA256(username + clientId, clientSecret))` necesita el
*username*. La app solo envía `{ "refresh_token": "..." }`, y el refresh token de
Cognito es opaco: no se puede sacar el username de él. **Con el contrato tal como
está, `/auth/refresh` no puede funcionar** con un client con secreto.

Tres salidas, seleccionables con `COGNITO_REFRESH_USERNAME_MODE`:

- **`envelope`** (por defecto cuando hay secreto, y lo que se implementó): el
  login devuelve el refresh token envuelto en un blob base64url que también lleva
  el username. La app lo trata como una cadena opaca, igual que antes; no hay que
  tocarla ni añadir estado en el backend. El sobre **no es un secreto**: contiene
  el correo del propio dueño de la sesión y su propio refresh token. Manipularlo
  no da acceso a nada — con otro username el `SECRET_HASH` no cuadra y Cognito
  responde 401.
- **`none`**: app client **sin** secreto. Es una opción razonable aquí: quien
  llama a Cognito es el Lambda, no el dispositivo, y la protección real la dan el
  IAM del Lambda y el authorizer. Elimina el problema de raíz.
- **`body`**: la app envía también `username`/`email`. Requiere tocar la app.

### Hallazgo 3 — El auto-registro abierto es el riesgo más serio del diseño

`POST /auth/register` sin autorizador permite a **cualquiera que alcance la URL**
crear una cuenta confirmada, con sesión inmediata, y a partir de ahí escribir
logs de auditoría de consentimientos médicos firmados. La `x-api-key` no lo
impide: va dentro del bundle de la app y se extrae en minutos.

Por eso `REGISTRATION_ENABLED` **está en `false` por defecto**: el endpoint
responde `403` hasta que alguien decida lo contrario de forma consciente.

Recomendación, en orden: (1) crear el personal clínico desde la consola de
Cognito y quitar la pantalla de registro —el propio contrato ya contempla esta
salida—; (2) si tiene que existir, exigir `REGISTRATION_INVITE_CODE` (ya
implementado) y restringir el dominio del correo; (3) como mínimo, WAF con límite
de tasa por IP sobre esa ruta.

### Hallazgo 4 — Las rutas de `/auth/*` no tienen protección de fuerza bruta

Van sin autorizador por definición. Cognito tiene sus propios límites, pero
devuelve `TooManyRequestsException` de forma poco predecible y no protege contra
*password spraying* distribuido (una contraseña común contra muchos correos).

Recomendación: **límite de tasa por ruta** en el stage (5 rps en `/auth/login`) y
**threat protection de Cognito**. Un WAF no se puede asociar a un HTTP API (v2):
haría falta CloudFront delante. Es configuración de infraestructura, no de
código — detalle en [`REVISION_API_GATEWAY.md`](REVISION_API_GATEWAY.md#r2--sin-límite-de-tasa).

### Hallazgo 5 — El `409` en un reenvío del outbox rompe la app

El contrato dice `ConditionalCheckFailedException → 409` en la prosa y
`200 { duplicate: true }` en el ejemplo de código. Son incompatibles: la app trata
cualquier `4xx` como respuesta definitiva del backend y le mostraría un error al
usuario por un log que **ya estaba guardado correctamente**. Se implementó el
`200`. Si en algún momento se quiere distinguir, que sea con el campo `duplicate`,
no con el código de estado.

### Hallazgo 6 — El `pdf_s3_key` del cliente no puede usarse para firmar

`capture_metadata.pdf_s3_key` llega en el log como una predicción del
dispositivo. Firmar una URL sobre esa clave dejaría que un dispositivo
autenticado escribiera en cualquier ruta del bucket (`../`, la carpeta de otro
paciente, un objeto de configuración). La clave se construye siempre en el
servidor y el `consent_id` se valida antes. El versionado y el Object Lock del
bucket limitan el daño, pero la puerta no debe existir.

### Hallazgo 7 — Una URL firmada sin límite de tamaño es una escritura al portador

Los 5 minutos de vigencia son correctos, pero por sí solos no impiden subir un
archivo de 5 GB con esa URL. Por eso se firma también `content-length`
(`PDF_SIGN_CONTENT_LENGTH=true`, activo por defecto) y se valida contra
`PDF_MAX_BYTES` antes de firmar. Con eso, la URL solo sirve para el documento
exacto que se declaró: ese hash y ese tamaño.

### Hallazgo 8 — Datos identificables del paciente en la llave de partición

`PK = PATIENT#<cédula>` deja el número de documento en claro en la llave, en los
índices, en los logs de consulta y en cualquier export. Añádase el nombre
completo y el dato biométrico y el ítem es historia clínica completa, sujeta en
Colombia a la Ley 1581 de 2012 y a la Resolución 1995 de 1999.

Recomendaciones: cifrado de la tabla con **CMK propia** (no la llave de AWS por
defecto), `PK = PATIENT#<HMAC-SHA256(cédula, llave en KMS)>` si alguna vez hay que
compartir exports —consultar por cédula sigue siendo posible recalculando el
HMAC—, y CloudTrail de plano de datos sobre la tabla y el bucket. El logger de
esta implementación ya redacta contraseñas, tokens, biometría y URLs firmadas
para que nada de eso llegue a CloudWatch.

### Hallazgo 9 — Express dentro de Lambda: es una decisión, no un accidente

Un solo Lambda con Express para las cinco rutas cuesta unos 30–60 ms más de
arranque en frío y un bundle mayor que cinco funciones sueltas, y da a todas las
rutas el mismo rol de IAM: el permiso de `AdminCreateUser` acaba disponible en la
misma función que atiende `/audit/logs`, en contra de la tabla de IAM por ruta del
contrato.

A cambio: un solo despliegue, middlewares y manejo de errores compartidos, y el
mismo código corre en local como servidor normal. Para el volumen de una clínica
es el equilibrio correcto, y era lo pedido. Si más adelante se quiere seguir la
tabla de IAM al pie de la letra, la estructura ya lo permite: `src/services/`
no depende de Express y cada ruta puede pasar a su propia función sin reescribir
la lógica. Un paso intermedio barato: separar `auth` de `audit + consents` en dos
funciones, que es donde está la asimetría de permisos que importa.

### Hallazgo 10 — El hash hace el documento verificable, no irrefutable

Lo que ya señala el contrato, y conviene no perder de vista: la cadena
`firma → hash → S3 con Object Lock` demuestra que el PDF no cambió **desde que se
registró**. No demuestra *cuándo* existió frente a un tercero. Si esto tiene que
sostenerse en un litigio: sello de tiempo RFC 3161, o un digest firmado con KMS
(`kms:Sign` con una llave asimétrica) sobre `{pdf_sha256, timestamp, consent_id}`
en el momento de recibir el log. Son unas pocas líneas en `auditService.js`
cuando exista la llave.

### Notas menores

- **`x-api-key` no es autenticación.** Está dentro del bundle de la app; cualquiera
  la extrae. Y **un HTTP API (v2) no admite API keys ni planes de uso** —eso es de
  REST API (v1)—, así que si tiene que servir de algo, la validación es la local
  (`API_KEY_ENFORCED=true`) o un autorizador Lambda. Para cuota, lo que aplica es
  el límite de tasa por ruta del stage. Ver
  [`REVISION_API_GATEWAY.md`](REVISION_API_GATEWAY.md).
- **`requireAuth` falla cerrada.** Si una ruta protegida llega sin claims del
  authorizer —porque se olvidó configurarlo, o porque alguien añadió una Function
  URL— la petición se rechaza con `401`. No se confía en el Bearer sin verificar
  salvo en desarrollo, y nunca con `NODE_ENV=production`.
- **CORS**: no se usa `*` junto a `Authorization`; se refleja el origen concreto
  de la lista blanca. En producción debería configurarse en el propio gateway.
- **Vigencia del token**: 12 h en el app client *y* `EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS=12`
  en la app. Si no coinciden, la app renueva tarde y pierde una petición en cada
  desfase. Un access token de 12 horas es largo; se acepta porque cubre la jornada
  y porque la alternativa es que el usuario reinicie sesión a media consulta, pero
  conviene tenerlo presente: 12 horas es también la ventana de un token robado.

---

## 7. Lista de comprobación de infraestructura

Nada de esto es código; es lo que tiene que existir para pasar los adaptadores a
`aws`.

**Cognito**
- [ ] User pool con `email` como alias y atributo `name`.
- [ ] App client con `ALLOW_ADMIN_USER_PASSWORD_AUTH`; decidir **con o sin
      secreto** según el Hallazgo 2.
- [ ] Access token 12 h; refresh token 30 días.
- [ ] JWT authorizer en el HTTP API sobre `/audit/*` y `/consents/*`, y **nada**
      sobre `/auth/*`.
- [ ] Que el tipo de token del authorizer coincida con `COGNITO_TOKEN_FOR_APP`.

**DynamoDB**
- [ ] Tabla `consent_audit_logs`, on-demand, PITR activado.
- [ ] GSI1: `CLINIC#<sede>` / `LOG#<iso>`, proyección `INCLUDE`.
- [ ] **GSI2: `CONSENT#<consent_id>` / `LOG#<iso>`** (Hallazgo 1).
- [ ] Cifrado con CMK propia (Hallazgo 8).

**S3**
- [ ] Bucket con versionado **y Object Lock**, que solo puede habilitarse **al
      crear el bucket**.
- [ ] Cifrado KMS (`PDF_SSE_KMS_KEY_ID`) y bloqueo total de acceso público.
- [ ] Notificación `s3:ObjectCreated:*` con prefijo `consents/` hacia el
      verificador.
- [ ] Retención según la normativa de historia clínica **antes** de cualquier
      regla de lifecycle. Sin expiración por defecto.

**API Gateway / Lambda**
- [ ] HTTP API, integración Lambda proxy **payload 2.0**.
- [ ] Stage `$default` (o `API_STAGE_PREFIX` con el nombre del stage).
- [ ] Throttling por ruta y WAF sobre `/auth/*` (Hallazgo 4).
- [ ] Rol de ejecución por función:

| Función | Permisos |
| --- | --- |
| API (auth) | `cognito-idp:AdminInitiateAuth` y, si hay registro, `AdminCreateUser` + `AdminSetUserPassword` |
| API (audit) | `dynamodb:PutItem` sobre la tabla |
| API (pdf-url) | `dynamodb:Query` (tabla + GSI2), `dynamodb:UpdateItem`, `s3:PutObject` sobre `consents/*`, `kms:GenerateDataKey` |
| Verificador | `s3:GetObject`, `s3:GetObjectAttributes`, `dynamodb:Query`, `dynamodb:UpdateItem` |

- [ ] Variables de entorno de cada función tomadas de `.env.example`.
- [ ] `NODE_ENV=production` (activa la comprobación que impide desplegar con
      adaptadores simulados).

**Empaquetado**

```bash
npm ci --omit=dev
zip -r api.zip src node_modules package.json
```

El SDK v3 se declara como dependencia en vez de confiarse al runtime: los
runtimes recientes de Lambda ya no garantizan qué versión incluyen.

**Contenedor.** El `Dockerfile` tiene dos destinos: `runtime` (por defecto,
Express en el puerto 3000, para desarrollo o para ECS/Fargate) y `lambda`
(imagen base de AWS Lambda, para probar el handler real con el emulador de
runtime).

```bash
docker build -t acr-api . && docker run --rm -p 3000:3000 --env-file .env acr-api

docker build -t acr-api-lambda --target lambda .
docker run --rm -p 9000:8080 acr-api-lambda
curl -s "http://localhost:9000/2015-03-31/functions/function/invocations" -d @scripts/evento-ejemplo.json
```

La imagen trae `ALLOW_STUB_IN_PRODUCTION=true` porque `NODE_ENV=production` y los
adaptadores simulados son incompatibles a propósito. **Quítelo en cuanto el
`.env` apunte a recursos reales.**

---

## 8. Prueba de humo

`npm run smoke` no arranca un servidor: construye **eventos de API Gateway HTTP
API reales** (cuerpo como string, claims en
`requestContext.authorizer.jwt.claims`, `sourceIp`, `timeEpoch`) y los pasa al
handler de Lambda, así que también verifica el adaptador y no solo Express.

Recorre: salud → registro → login → credenciales malas → enumeración de cuentas →
refresh → refresh inválido → auditoría sin token → auditoría → reenvío duplicado →
validaciones → sobrescritura de IP/operador/reloj → URL firmada → checksum en
base64 → corrección de `pdf_s3_key` → hash distinto → log inexistente → path
traversal → verificador de S3 → 404 → JSON inválido.

```
$ npm run smoke
ok   GET /health responde 200
...
Todo correcto.
```

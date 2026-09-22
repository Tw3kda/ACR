# Plan: S3 con Object Lock COMPLIANCE como registro de auditoría

**Estado:** ejecutado el 2026-09-21, con tres cambios sobre lo escrito abajo:
> - **Sin DynamoDB.** Ni siquiera como índice: los listados por paciente, sede y fecha son
>   punteros vacíos en `index/…` del mismo bucket (§4 queda superado).
> - **Sin KMS.** SSE-S3 en los tres buckets; la clave era la única partida no gratuita.
> - **Retenciones:** PDFs 30 días, evidencia 365, en dos buckets (una retención por bucket).
>   Modo GOVERNANCE mientras sea entorno de pruebas; `object_lock_mode = "COMPLIANCE"` en
>   `infra/platform` al pasar a producción.
> - **Sin CloudTrail** (decisión del 2026-09-21): con COMPLIANCE nadie puede borrar ni
>   acortar un objeto, y eso se consideró suficiente. Se pierde la atribución por objeto
>   (quién escribió/leyó cada uno); queda el historial de eventos de gestión de 90 días
>   que AWS mantiene gratis sin trail. Las menciones a CloudTrail más abajo son históricas.
> - **Una sola llamada** (2026-09-21): `POST /consents` recibe log + PDF, verifica el hash,
>   guarda el PDF y escribe 0001 y 0002 en la misma petición. Sin URL presignada, sin subida
>   directa a S3, sin Lambda verificador. Las políticas de bucket (`OnlyTheServiceAppends`,
>   `WriteOnce`) cubren ahora los dos buckets. La app guarda en disco lo que no pudo enviar.
**Fecha:** 2026-09-20
**Decisión que sustituye:** DynamoDB como registro principal + copia por stream a S3

## 1. Qué cambia, en una frase

Hoy la verdad vive en DynamoDB (editable) y se copia a S3 (inmutable). Mañana la verdad
**nace** en S3 bajo Object Lock COMPLIANCE — donde nadie, ni root, puede modificarla ni
borrarla antes del plazo — y DynamoDB pasa a ser un índice derivado, reconstruible desde
S3 en cualquier momento, cuya mutabilidad deja de importar.

```
HOY
  app ──POST /audit/logs──▶ DynamoDB (PutItem) ──stream──▶ Lambda ──▶ S3 (copia)
                                  ▲ verdad                              evidencia

MAÑANA
  app ──POST /audit/logs──▶ S3 events/<id>/0001-CONSENT_SIGNED.json ──▶ DynamoDB (índice)
                                  ▲ verdad, bloqueada al escribirse       reconstruible
```

Un consentimiento deja de ser "una fila que se actualiza" y pasa a ser **una secuencia de
eventos inmutables**: `CONSENT_SIGNED`, luego `PDF_VERIFIED`. El estado es la lectura de
esa secuencia. Nada se actualiza jamás; solo se añade.

## 2. Por qué S3 y no CloudWatch

| | DynamoDB (hoy) | CloudWatch Logs | **S3 Object Lock** |
| --- | --- | --- | --- |
| Editar/borrar un registro | Posible | Imposible por evento; posible por stream | **Imposible durante la retención, root incluido** |
| Buscar por consent_id | Instantáneo (GSI2) | Consulta de 1–5 s | **Instantáneo: la clave es el id** |
| Reenvío duplicado del outbox | Rechazado atómicamente | Crea duplicado | **Rechazado atómicamente** (`If-None-Match`) |
| Marcar el PDF como verificado | Update en sitio | Segundo evento | **Segundo objeto** |
| Retención | Ninguna | Configurable, un admin la acorta | **Por objeto, nadie la acorta** |
| Listar por paciente / sede | Instantáneo | Consulta | Índice derivado (DynamoDB) o Athena |

S3 gana en todo salvo en listar, y para listar se conserva DynamoDB como caché. Además ya
existe: el bucket, el verificador, los hashes, CloudTrail sobre él. Es el camino que menos
piezas nuevas añade y más piezas quita.

## 3. Plazo de retención: la decisión irreversible

COMPLIANCE exige un número de días y **no admite acortarlo después**. El bucket no se
podrá vaciar ni eliminar hasta que expire el último objeto. Hay que fijarlo bien a la
primera.

Referencia normativa: la Resolución 839 de 2017 (MinSalud) fija la conservación de la
historia clínica en **15 años desde la última atención**. El consentimiento informado forma
parte de ella. **Confirmar con asesoría legal** que aplica al consentimiento de toma de
muestras y que 15 años es el mínimo y no otro plazo mayor por otra norma.

| Entorno | Modo | Retención | Motivo |
| --- | --- | --- | --- |
| `prod` (sin prefijo) | **COMPLIANCE** | 5 479 días (15 años) | Es el registro legal |
| `dev` | GOVERNANCE | 30 días | Se puede desmontar; las pruebas no quedan 15 años |

Consecuencia operativa que hay que interiorizar: **en `prod` no se hacen pruebas.** Un log
de smoke escrito en el bucket de producción queda 15 años. El smoke test se ejecuta
contra `dev` y se niega a arrancar contra `prod` (ver §9).

## 4. Diseño del almacenamiento

Un solo bucket de evidencia: el actual `medical-consent-pdfs-<cuenta>`. No se renombra
(recrearlo destruiría lo que contiene); pasa a albergar dos prefijos:

```
consents/<año>/<mes>/<consent_id>.pdf                 (ya existe)
events/<consent_id>/0001-CONSENT_SIGNED.json          (nuevo)
events/<consent_id>/0002-PDF_VERIFIED.json            (nuevo)
events/<consent_id>/0003-…                            (futuros: CONSENT_REVOKED, …)
```

Por qué el id en la clave: la ruta `/consents/{id}/pdf-url` necesita el `pdf_sha256` del
log para firmar la subida. Con esta clave es un `GetObject` directo, sin índice ni consulta.

Cada evento:

```json
{
  "schema": "acr.consent.event/1",
  "seq": 1,
  "event_type": "CONSENT_SIGNED",
  "consent_id": "CONS-2026-0912-668",
  "recorded_at_utc": "2026-09-12T06:04:56.255Z",
  "prev_hash": null,
  "payload": { ...el log completo que envía la app, con ip_address y operator_id ya sobrescritos... }
}
```

- `prev_hash`: SHA-256 de los bytes del evento anterior de ese consentimiento (`null` en
  el primero). Encadena la secuencia: quitar o insertar un evento en medio rompe la cadena
  y un script lo detecta sin ayuda de AWS.
- El objeto se sube con `ChecksumSHA256`: S3 verifica los bytes al recibirlos y guarda el
  checksum, que `GetObjectAttributes` devuelve después. Tercer testigo independiente.
- Object Lock aplica la retención por defecto del bucket en el instante del `PutObject`.
  No hay ventana en la que el evento exista sin estar bloqueado.

### DynamoDB como índice

La tabla `consent_audit_logs` se conserva con el mismo ítem de hoy, pero:

- Se escribe **después** de S3, nunca antes. Si S3 falla, no hay log; si el índice falla,
  el log existe igual y el índice se reconstruye.
- `pdf_verified` se actualiza desde el verificador como hoy. Sigue siendo cómodo.
- Se elimina el **stream** y todo lo que cuelga de él (§6).
- `scripts/rebuild-index.mjs` recorre `events/` y regenera la tabla entera. Es la prueba
  de que la tabla no es la verdad: se puede borrar y volver a crear sin perder nada.

## 5. Cómo cambia el flujo del servicio

### 5.1 `POST /audit/logs`

```
1. Validar el cuerpo (igual que hoy)
2. Sobrescribir ip_address, operator_id, received_at_utc (igual que hoy)
3. PutObject events/<id>/0001-CONSENT_SIGNED.json
       If-None-Match: *            ← crea-una-sola-vez, atómico
       ChecksumSHA256: <sha>
   ├─ 200 OK           → nuevo
   ├─ 412 Precondition → ya existe: GetObject y comparar log_id
   │      mismo log_id  → 200 { duplicate: true }   (reenvío del outbox)
   │      otro log_id   → 409 "consent_id ya usado"  (colisión, ver §8)
4. PutItem en DynamoDB (índice). Si falla: log de error, NO se revierte S3, 201 igual.
5. 201 { log_id }
```

Latencia añadida: un `PutObject` (~40–80 ms). Irrelevante frente al arranque en frío.

`If-None-Match: *` es una escritura condicional de S3 (disponible desde 2024, soportada
por el SDK v3 como `IfNoneMatch`). Sustituye al `ConditionExpression` de DynamoDB con la
misma garantía: dos reenvíos simultáneos, uno gana, el otro recibe 412.

### 5.2 `POST /consents/{id}/pdf-url`

```
1. GetObject events/<id>/0001-CONSENT_SIGNED.json      ← la verdad, no el índice
   404 → 404 "consentimiento sin log"
2. Comparar payload.signature_data.pdf_sha256 con el del cuerpo
   distinto → 409
3. Firmar el PUT (sin cambios: checksum firmado, content-length firmado)
4. UpdateItem pdf_s3_key en el índice (opcional; ya no es "corrección de la verdad")
```

Deja de leerse `GSI2`. El índice ya no está en el camino crítico de nada.

### 5.3 Verificador (`s3:ObjectCreated` sobre `consents/*.pdf`)

```
1. GetObjectAttributes del PDF → checksum real
2. GetObject events/<id>/0001-CONSENT_SIGNED.json → pdf_sha256 declarado
3. PutObject events/<id>/0002-PDF_VERIFIED.json (If-None-Match: *)
     { seq: 2, event_type: PDF_VERIFIED, verified: true|false, checksum, size,
       prev_hash: sha256(bytes de 0001) }
4. UpdateItem pdf_verified en el índice (derivado)
```

El resultado de la verificación queda como evidencia inmutable, no como un flag editable.
Si el verificador se dispara dos veces por el mismo objeto (S3 lo permite), el
`If-None-Match` hace la segunda inofensiva.

### 5.4 Lo que no cambia

- **La app móvil.** El contrato del gateway es el mismo: mismas rutas, mismos cuerpos,
  mismas respuestas. Solo aparece un `409` nuevo por colisión de id (§8).
- La subida directa a S3 con checksum firmado.
- Cognito, el autorizador, el refresh.
- El `auditor` de solo lectura (ampliar a `events/*`).

## 6. Qué se elimina

| Qué | Dónde | Por qué |
| --- | --- | --- |
| Stream de la tabla (`stream_enabled`) | `infra/platform/dynamodb.tf` | La verdad ya no pasa por DynamoDB |
| Lambda `audit_trail`, su rol, política, DLQ y mapeo | `infra/api/audit_trail.tf` (archivo entero) | Copiaba DynamoDB → S3; ahora se escribe en S3 directamente |
| `src/handlers/auditTrail.js` | backend | ídem |
| `@aws-sdk/util-dynamodb` | `package.json` | Solo lo usaba el handler anterior |
| Prefijo `dynamodb/` del bucket `audit-trail` | — | Dejará de recibir objetos; el que existe (mi prueba de edición) queda hasta su retención |
| Sentencia `StreamStaysConnected` | SCP (`infra/org/main.tf`) | Ya no hay stream que proteger |
| `GSI2` | `dynamodb.tf` | **Opcional.** Ya nadie lo lee en el camino crítico. Conservarlo cuesta nada y sirve al script de evidencia; se puede quitar más adelante |

El bucket `medical-consent-audit-trail-<cuenta>` **se conserva** para CloudTrail: sigue
siendo el registro de *quién hizo qué*, y está bajo su propio Object Lock.

## 7. Qué se modifica

### Backend (`API GATEWAY`)

| Archivo | Cambio |
| --- | --- |
| `src/aws/evidence.aws.js` **(nuevo)** | `putEventOnce(consentId, seq, type, body)` con `IfNoneMatch: '*'` + checksum; `getEvent(consentId, seq)`; `listEvents(consentId)`. Y su `evidence.stub.js` para desarrollo sin AWS |
| `src/aws/index.js` | Exportar el nuevo adaptador con selección de driver como los demás |
| `src/config/env.js` | `EVIDENCE_BUCKET` (= `PDF_BUCKET`), `EVIDENCE_EVENTS_PREFIX=events` |
| `src/services/auditService.js` | Escribir S3 primero (§5.1); DynamoDB después y no fatal; devolver `duplicate` por `log_id`; 409 por colisión |
| `src/services/pdfUrlService.js` | `pdf_sha256` desde el evento 0001, no desde GSI2. El verificador escribe 0002 |
| `src/handlers/pdfVerifier.js` | Sin cambios de forma; llama al servicio modificado |
| `scripts/smoke-remote.mjs` | Aserciones sobre `events/`; cadena de hashes; **negarse a correr contra el bucket de prod** (§9) |
| `scripts/evidence.mjs` **(nuevo)** | Paquete de evidencia por consent_id (§10) |
| `scripts/rebuild-index.mjs` **(nuevo)** | Regenera la tabla desde `events/` |
| `docs/API_CONTRACT.md` | Modelo de eventos, el 409 nuevo, `pdf_verified` como evento |

### Terraform `infra/platform`

| Archivo | Cambio |
| --- | --- |
| `variables.tf` | `object_lock_default_retention_days` deja de aceptar `null`: obligatorio. `object_lock_mode` por entorno (§3) |
| `s3.tf` | La regla de retención por defecto deja de ser condicional |
| `dynamodb.tf` | Quitar `stream_enabled` / `stream_view_type` |
| `readonly_user.tf` | Añadir `events/*` a lo que el auditor puede leer (ya cubre `pdf_bucket/*`; verificar) |
| `outputs.tf` | Quitar `audit_table_stream_arn` |

### Terraform `infra/api`

| Archivo | Cambio |
| --- | --- |
| `iam.tf` | Rol del API: `s3:PutObject` + `s3:GetObject` sobre `events/*`. Verificador: `s3:PutObject` + `s3:GetObject` sobre `events/*`, `GetObjectAttributes` sobre `consents/*` (ya lo tiene) |
| `audit_trail.tf` | **Eliminar** |
| `outputs.tf` | `EVIDENCE_EVENTS_PREFIX` en `lambda_environment` |

### Terraform `infra/org` (SCP)

| Sentencia | Cambio |
| --- | --- |
| `StreamStaysConnected` | Eliminar |
| `EvidenceCannotBeDestroyed` | Sin cambios; ya cubre `pdf_bucket/*` |
| **`OnlyTheServiceAppends` (nueva)** | Deny `s3:PutObject` sobre `events/*` y `consents/*` salvo a los roles del API y del verificador. Object Lock impide *alterar*; esto impide *fabricar*: sin ello un admin podría plantar un evento falso con formato correcto |
| `PutObjectLegalHold` | Hoy denegado a todos. Pasar a denegado **salvo a un rol `legal-hold`** que solo exista para litigios: una retención legal bloquea el objeto indefinidamente, más allá del plazo |

### App móvil (`CONCENTIMIENTO_INFORMADO`)

| Archivo | Cambio |
| --- | --- |
| `src/services/ids.ts` | `createConsentId`: sufijo de 3 dígitos → 10 caracteres hex de un UUID. Ver §8 |
| Pantalla final | Mostrar el 409 de colisión como error legible (hoy mostraría el `message` del backend tal cual, que ya es aceptable) |

## 8. Riesgo nuevo: colisión de `consent_id`

Hoy el id es `CONS-AAAA-MMDD-NNN` con `NNN` aleatorio de 0 a 999. En DynamoDB una
colisión era improbable e inofensiva (la clave es `PATIENT#…` + fecha). En S3 **el id es
la clave**: dos tablets que generen el mismo `NNN` el mismo día chocan, y el segundo recibe
un 409 con el PDF ya generado.

Con 1 000 valores por día, la probabilidad de al menos una colisión supera el 1 % a partir
de ~5 consentimientos diarios y el 50 % con ~37. **No es aceptable.** Pasar a
`CONS-AAAA-MMDD-<10 hex>` (40 bits): la colisión pasa a ser una vez cada millones de años
a cualquier volumen razonable. El formato sigue siendo legible y ordenable por fecha.

Este es el único cambio de la app y debe desplegarse **antes** de que el backend empiece a
usar el id como clave.

## 9. Orden de ejecución

COMPLIANCE es irreversible. El orden importa más que en cualquier otro cambio hecho hasta
ahora.

```
 1. App: ampliar createConsentId. Publicar la app. (los ids viejos siguen valiendo)
 2. Backend: nuevo adaptador + servicios. Smoke local con start:aws contra un bucket dev.
 3. Terraform: crear el entorno `dev` (name_prefix=dev, GOVERNANCE 30 d). Desplegar ahí.
 4. Smoke remoto contra dev, 16/16 + cadena de hashes.
 5. LIMPIEZA de prod, mientras aún se puede:
      - borrar los 4 logs CONS-SMOKE-* de la tabla y sus 2 PDFs
      - borrar el usuario smoke@ de Cognito
      - dejar solo CONS-2026-0912-668
 6. Backfill de prod: escribir events/CONS-2026-0912-668/0001 y 0002 desde la fila
    existente (con "migrated_from": "dynamodb" y el log_id original), y aplicar
    retención COMPLIANCE explícita a su PDF (put-object-retention).
 7. Terraform prod: retención por defecto COMPLIANCE 5479 d en el bucket de evidencia.
    ─── a partir de aquí no hay marcha atrás ───
 8. Desplegar backend a prod. Smoke NO (ver abajo). Firmar un consentimiento real desde
    la tablet y verificar con scripts/evidence.mjs.
 9. Eliminar stream, Lambda del rastro, DLQ, mapeo (§6).
10. SCP: quitar StreamStaysConnected, añadir OnlyTheServiceAppends, aplicar.
```

**El smoke test contra prod queda prohibido por construcción:** `smoke-remote.mjs`
consultará la configuración de Object Lock del bucket destino y abortará si el modo es
COMPLIANCE. Un descuido no puede costar 15 años de basura en el registro legal.

## 10. Listo para auditoría: qué se entrega y cómo se verifica

`scripts/evidence.mjs --consent CONS-2026-0912-668` produce una carpeta:

```
CONS-2026-0912-668/
  MANIFEST.json          qué hay, hashes de cada archivo, fecha de extracción, quién extrajo
  0001-CONSENT_SIGNED.json
  0002-PDF_VERIFIED.json
  CONS-2026-0912-668.pdf
  s3-attributes.json     checksum y retención que S3 guarda de cada objeto
  cloudtrail.json        cada llamada que tocó estos objetos: identidad, IP, hora
  VERIFICATION.txt       resultado de las comprobaciones de abajo
```

Y `VERIFICATION.txt` contiene el resultado de cuatro comprobaciones que cualquiera puede
repetir sin la app ni el backend:

1. `sha256sum` del PDF descargado == `pdf_sha256` dentro del evento 0001.
2. Ese mismo valor == checksum que S3 calculó al recibir el PDF (`GetObjectAttributes`).
3. `sha256` de los bytes de 0001 == `prev_hash` dentro de 0002 (cadena intacta).
4. Retención de cada objeto: modo COMPLIANCE, fecha de expiración ≥ 15 años desde el
   evento. Nadie pudo alterarlos y nadie podrá hasta entonces.

Lo que un auditor obtiene: el documento, la prueba de que es el mismo que se firmó, la
prueba de que la verificación ocurrió y cuándo, quién lo tocó, y la garantía técnica de
que ninguna de esas piezas se pudo cambiar después. Con el SCP activo, ni siquiera
fabricar una pieza nueva con formato correcto.

Pendiente de decidir, no bloqueante: un **manifiesto diario** (`manifests/<fecha>.json`
con las claves y hashes de todos los eventos del día) escrito por una Lambda programada.
Object Lock ya impide borrar; el manifiesto permite además demostrar *completitud* —
que no falta ningún consentimiento de ese día. Vale la pena cuando el volumen lo
justifique.

## 11. Costes y esfuerzo

Coste mensual: sin cambio (~1 USD, la CMK). Se quitan una Lambda, una cola y un stream;
se añaden dos `PutObject` por consentimiento.

Esfuerzo: 2–3 días. Reparto aproximado: adaptador y servicios ½ día, Terraform y SCP ½ día,
scripts de evidencia y reconstrucción ½ día, entorno dev + smoke + migración de prod 1 día.
La app, una hora.

## 12. Lo que sigue sin resolver este plan

- **Quién puede borrar DynamoDB.** Nadie debería, pero como es un índice, si alguien lo
  hace se reconstruye. El SCP sobre la tabla se mantiene por higiene, no por evidencia.
- **Un admin que fabrica un evento.** Lo cubre el SCP `OnlyTheServiceAppends` — y solo
  cuando la cuenta de gestión exista. Hasta entonces, CloudTrail lo registraría con
  nombre, pero no lo impediría.
- **El plazo legal.** Este documento asume 15 años. Si asesoría legal dice otra cosa, se
  cambia el número **antes** del paso 7. Después, solo se puede alargar.

# Revisión de la configuración de API Gateway

> **Estado (2026-09-21): el registro de auditoría ya NO vive en DynamoDB.** Este
> documento describe el diseño anterior. La verdad es ahora S3 con Object Lock —
> eventos inmutables `events/<consent_id>/000N-*.json` más punteros de índice — y
> DynamoDB, su stream, el Lambda del rastro y la clave KMS se eliminaron. El diseño
> vigente está en `docs/PLAN_S3_COMPLIANCE.md` (ejecutado) y en `docs/API_CONTRACT.md`.

Revisión del Terraform propuesto para el HTTP API, contrastado contra lo que la
app envía y lo que la Lambda espera. La versión corregida está en
[`infra/api/api_gateway.tf`](../infra/api/api_gateway.tf).

**Resumen:** un error que impide iniciar sesión, dos que rompen Expo web, y
varias omisiones de operación y seguridad. La estructura general —HTTP API,
payload 2.0, autorizador JWT de Cognito, integración proxy— es la correcta.

| # | Hallazgo | Gravedad |
| --- | --- | --- |
| E1 | `ANY /{proxy+}` con JWT deja `/auth/login` detrás del autorizador | **Bloqueante** |
| E2 | Falta `x-api-key` en `allow_headers` | Alta |
| E3 | `allow_origins = ["*"]` | Media |
| E4 | `x-amz-checksum-sha256` en el gateway, donde no se usa; falta el CORS del bucket | Media |
| E5 | Métodos de CORS que el API no expone | Baja |
| R1 | Sin logs de acceso | Alta |
| R2 | Sin límite de tasa, ni general ni en `/auth/*` | Alta |
| R3 | `/auth/register` publicado por la ruta comodín | Alta |
| R4 | `/health` público devolviendo detalles de configuración | Media |
| R5 | `timeout_milliseconds` por defecto: 30 s | Baja |
| R6 | `source_arn` sin acotar al stage | Baja |

---

## E1 — El login queda detrás del autorizador *(bloqueante)*

```hcl
resource "aws_apigatewayv2_route" "proxy_route" {
  route_key          = "ANY /{proxy+}"
  authorization_type = "JWT"          # <- se aplica a TODO
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}
```

`POST /auth/login` cae dentro de `/{proxy+}`, y la única ruta que queda fuera es
`GET /health`. Es decir: **hay que presentar un token válido para poder obtener
un token**. La app no podría iniciar sesión nunca, ni registrarse, ni renovar.

Lo que lo vuelve caro de diagnosticar es el síntoma: un `401` en el login con
credenciales correctas. Todo apunta a Cognito —contraseña, `SECRET_HASH`, el app
client— y el problema está en la ruta. Además, como el autorizador rechaza antes
de invocar la función, **en los logs de la Lambda no hay absolutamente nada**.

**Corregido** con rutas explícitas: `/auth/login`, `/auth/refresh` y `/health`
con `authorization_type = "NONE"`; `/audit/logs` y `/consents/{consent_id}/pdf-url`
con el autorizador JWT.

Alternativa mínima si se quiere conservar el comodín: añadir las tres rutas de
`/auth/*` como recursos aparte con `NONE`. En un HTTP API la ruta más específica
gana sobre `{proxy+}`, así que funcionaría. Aun así prefiero las rutas
explícitas: permiten límite de tasa por ruta, dejan por escrito qué está
protegido, y hacen trivial mover `/auth/*` a otra Lambda el día que se quieran
separar los permisos de IAM.

---

## E2 — Falta `x-api-key` en `allow_headers`

La app añade ese encabezado en cuanto `EXPO_PUBLIC_API_KEY` está definida. Sin
declararlo, el preflight del navegador falla y **solo** falla en `expo start --web`:
en Android y iOS no hay CORS. Es el síntoma más confuso posible — funciona en la
tablet y no en el navegador.

## E3 — `allow_origins = ["*"]`

CORS aquí existe únicamente para el desarrollo en web. Un `*` publica el API a
cualquier origen sin ninguna ganancia. Corregido a la lista real
(`http://localhost:8081` por defecto, en una variable).

Con `allow_credentials = false` —que es el caso: la app autentica por encabezado
`Authorization`, no por cookies— el `*` no es una vulnerabilidad directa, pero no
hay razón para dejarlo abierto.

## E4 — `x-amz-checksum-sha256` está en el sitio equivocado

Ese encabezado viaja en el `PUT` **directo a S3**, que no pasa por el gateway.
Declararlo aquí no hace daño, pero delata la confusión, y lo importante es lo que
falta: **el bucket necesita su propia configuración de CORS** para que la subida
funcione desde Expo web. Queda como bloque comentado al final del archivo
corregido.

## E5 — Métodos que el API no expone

`GET, POST, PUT, DELETE, OPTIONS` para un API que solo usa `POST` (y `GET` en
`/health`). Reducido a lo que existe.

---

## R1 — Sin logs de acceso

Es la omisión que más va a doler durante la Fase 3 del plan. Cuando el
autorizador rechaza una petición, la Lambda **no se ejecuta**: no hay
`request_id`, no hay traza, no hay nada. Con `access_log_settings` y los campos
`$context.authorizer.error` e `$context.integrationErrorMessage` se ve
exactamente por qué.

Añadido, con grupo de logs y retención de 90 días.

## R2 — Sin límite de tasa

Un HTTP API sin `default_route_settings` hereda la cuota de la cuenta (10.000
peticiones por segundo). Dos consecuencias: una tablet en bucle genera una
factura considerable antes de que nadie lo note, y `/auth/login` queda abierto a
fuerza bruta sin ningún freno.

Añadido: 200 rps generales, y **5 rps en `/auth/login`** (10 de ráfaga). Para una
clínica sobra: el volumen normal es un login por profesional al empezar la
jornada.

### Corrección a una recomendación mía anterior sobre WAF

En `RECOMENDACIONES_Y_PLAN.md` recomendé (R5) poner **AWS WAF con
`AWSManagedRulesATPRuleSet` sobre `/auth/*`**. Revisándolo con la configuración
delante: **AWS WAF no se puede asociar a un HTTP API (v2)**. Solo admite REST API
(v1), CloudFront, ALB, AppSync, App Runner y user pools de Cognito.

Y asociarlo al user pool tampoco resuelve este caso: WAF sobre Cognito protege
los extremos públicos del pool, mientras que aquí quien llama es la Lambda con
`AdminInitiateAuth`, y todas esas peticiones salen de la misma IP.

Opciones reales, en orden de coste:

1. **Límite de tasa por ruta** en el stage — ya aplicado en el archivo corregido.
   Es por API, no por IP, pero es lo que hay sin infraestructura adicional.
2. **Threat protection de Cognito** (las antiguas *advanced security features*):
   detección de credenciales comprometidas y bloqueo adaptativo. Tiene coste por
   usuario activo.
3. **CloudFront delante del HTTP API con WAF asociado**, si se quiere un límite
   por IP de verdad y reglas gestionadas. Es la opción completa y la más cara.
4. **Límite en la aplicación**, con contador por IP y por correo en DynamoDB con
   TTL. Barato pero es código que hay que mantener, y no está implementado.

Para el volumen de una clínica, (1) y (2) son suficientes. Actualizo la
recomendación R5 en consecuencia.

## R3 — `/auth/register` quedaba publicado sin quererlo

La ruta comodín publicaba también el registro. La Lambda lo tiene cerrado por
defecto (`REGISTRATION_ENABLED=false`, responde `403`), pero la defensa correcta
es que la ruta **no exista** en el gateway: lo que no está publicado no se
fuerza. En el archivo corregido está tras `expose_register_route`, en `false`.

## R4 — `/health` público con detalles de configuración

La ruta era pública y la Lambda devolvía entorno, nombre del servicio y qué
adaptador estaba activo en cada servicio. Es útil para depurar y también para
alguien que esté mirando qué hay detrás.

**Corregido en el código**, no en el Terraform: con `HEALTH_DETAILED=false`
—valor por defecto en producción— `/health` responde `{"status":"ok"}` y nada
más. Actívelo temporalmente durante la Fase 3 para verificar el paso a AWS real.

## R5 y R6 — Detalles

- `timeout_milliseconds` bajado a 10 s. Por defecto son 30 s, el máximo; ninguna
  de estas rutas debería pasar de un par de segundos, y agotar los 30 multiplica
  el coste de un pico de errores.
- `source_arn` acotado al stage (`/$default/*/*`) para que un stage nuevo no
  herede el permiso de invocación sin querer. El `/*/*` original es válido —en un
  ARN de política el `*` también cruza las barras—, solo más amplio de lo
  necesario.

---

## Lo que estaba bien

Conviene decirlo, porque son las decisiones que más caro salen si se equivocan:

- **HTTP API en vez de REST API**: más barato y más rápido, y aquí no se usa
  nada de lo que solo tiene el v1... con una excepción que vale la pena conocer,
  más abajo.
- **`payload_format_version = "2.0"`** coincidiendo con lo que espera el
  adaptador de la Lambda. Con la 1.0, el evento llega con otra forma y todas las
  rutas fallan.
- **Stage `$default` con `auto_deploy`**: la URL no lleva prefijo de stage, que
  es justo el caso en que `API_STAGE_PREFIX` se deja vacío.
- **`identity_sources = ["$request.header.Authorization"]`** y el `issuer` de
  Cognito bien construido.
- **Integración `AWS_PROXY`** con una sola Lambda, coherente con el diseño.

### Sobre `audience` y el tipo de token

`audience = [client.id]` se compara contra el `aud` del token y, en los access
token de Cognito —que no llevan `aud` sino `client_id`—, contra `client_id`.
Sirve para las dos variantes.

Lo que **tiene** que coincidir es el tipo de token: la Lambda devuelve access
token por defecto (`COGNITO_TOKEN_FOR_APP=access`). Si el autorizador se
configurara para validar solo IdToken, toda ruta protegida devolvería `401` y el
síntoma parecería un problema de sesión. Verifíquelo con una llamada real en la
Fase 3.

### Corrección a otra afirmación mía anterior: `x-api-key`

En `API_IMPLEMENTATION.md` escribí que «la cuota real la aplica el plan de uso
del gateway». Eso es cierto en REST API (v1), **no en HTTP API (v2)**: los HTTP
API no admiten API keys ni planes de uso.

Con esta arquitectura, si se quiere que `x-api-key` sirva de algo, las opciones
son: validarla en la Lambda (`API_KEY_ENFORCED=true`, ya implementado), un
autorizador Lambda en el gateway, o el límite de tasa por ruta de R2. Sigue
siendo válido lo importante: **una API key dentro de una app móvil no es un
secreto**; cualquiera la extrae del bundle.

---

## Qué falta por definir fuera de este archivo

- Rol de ejecución de la Lambda con permisos por servicio (tabla en
  [`API_IMPLEMENTATION.md` §7](API_IMPLEMENTATION.md#7-lista-de-comprobación-de-infraestructura)).
- `aws_s3_bucket_cors_configuration` para el `PUT` directo (E4).
- Notificación `s3:ObjectCreated:*` con prefijo `consents/` hacia el verificador.
- `reserved_concurrent_executions` en la Lambda: sin él, un pico de peticiones
  puede consumir la concurrencia de toda la cuenta.
- Alarmas de CloudWatch sobre `5xx`, latencia p99 y errores del autorizador.

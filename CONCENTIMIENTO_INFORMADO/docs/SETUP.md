# Inicialización del proyecto

Este documento explica cómo se inicializó este proyecto (Expo + TypeScript + Expo Router)
y cómo levantarlo localmente.

## Comandos equivalentes de inicialización

```bash
npx create-expo-app@latest . --template expo-template-blank-typescript
npx expo install expo-router expo-linking expo-constants react-native-safe-area-context react-native-screens
npx expo install expo-sqlite expo-print expo-sharing expo-file-system expo-asset react-native-webview
npm install axios react-native-signature-canvas
```

Requiere Node.js 20 LTS instalado.

```bash
npm install
```

## Estructura del proyecto

```
.
├── app.json                       # Configuración de la app Expo (nombre, scheme, plugin de expo-router)
├── tsconfig.json                  # Alias de imports "@/*" -> "src/*"
├── package.json                   # main: "expo-router/entry"
├── docs/
│   └── SETUP.md                   # Este documento
├── assets/                        # Iconos, splash, fuentes
└── src/
    ├── app/                       # EXPO ROUTER (rutas y layouts, basado en archivos)
    │   ├── _layout.tsx            # Layout raíz: AuthProvider + SafeAreaProvider
    │   ├── index.tsx              # Redirección inicial
    │   ├── (auth)/                # Grupo de rutas sin autenticar
    │   │   ├── _layout.tsx
    │   │   ├── login.tsx
    │   │   └── register.tsx
    │   └── (app)/                 # Grupo de rutas autenticadas
    │       ├── _layout.tsx        # Guarda de sesión
    │       ├── settings.tsx
    │       └── consent/           # Flujo de consentimiento informado
    │           ├── _layout.tsx    # Monta el ConsentDraftProvider
    │           ├── index.tsx      # Selección de consentimiento
    │           └── [code]/
    │               ├── _layout.tsx
    │               ├── index.tsx        # 1. Diligenciar + firma del paciente
    │               ├── preview.tsx      # 2. Previsualizar y confirmar
    │               ├── handoff.tsx      # 3. Entregar el dispositivo al profesional
    │               ├── professional.tsx # 4. Firma del profesional → genera el PDF
    │               └── done.tsx         # 5. Descargar / compartir
    │
    ├── components/                # UI global compartida
    │   ├── ui/                    # Elementos átomo (Button, SignaturePad)
    │   ├── common/                # Elementos compuestos (Card, Header)
    │   └── logos/                 # Logo de ACR (ver su README)
    │
    ├── features/                  # Módulos por dominio
    │   ├── auth/
    │   │   ├── hooks/             # useLogin, useRegister
    │   │   └── services/          # authApi.ts (login/registro contra SQLite en fase 1)
    │   └── consent/
    │       ├── components/        # ConsentDocument, ConsentFields, ConsentPreview
    │       ├── data/              # caF14.ts — plantilla semilla en JSON
    │       ├── services/          # consentRepository, templateSchema, documentHtml, pdfService
    │       ├── store/             # consentDraftStore.tsx — borrador en curso
    │       └── types/             # ConsentTemplate, ConsentBlock, SignatureSlot…
    │
    ├── services/
    │   ├── apiClient.ts           # Cliente Axios global (fase 2)
    │   └── localDb.ts             # SQLite: usuarios + plantillas (stand-in de RDS)
    │
    └── store/
        └── authStore.ts           # Context de sesión: token, user, login(), logout()
```

### Flujo de navegación

1. **Sin sesión** → grupo `(auth)`: `login` / `register`.
2. **Con sesión** → grupo `(app)`: `consent` y `settings`.

Cada grupo (`(auth)/_layout.tsx` y `(app)/_layout.tsx`) redirige automáticamente si el
usuario no debería estar ahí (por ejemplo, al cerrar sesión vuelve a `(auth)/login`).

### Flujo de firma del consentimiento

`consent/index.tsx` lista las plantillas disponibles. Al elegir una se entra al flujo de
cinco pantallas en `consent/[code]/`:

1. **`index`** — el paciente diligencia los campos y firma.
2. **`preview`** — se muestra el documento completo en solo lectura. *"Confirmar"* avanza;
   *"No, corregir mis datos"* regresa al formulario.
3. **`handoff`** — pantalla de transición: *"entregue el dispositivo al profesional"*.
4. **`professional`** — el profesional firma y se genera el PDF.
5. **`done`** — descargar / compartir el PDF y finalizar.

Desde `handoff` en adelante el botón y el gesto de retroceso están deshabilitados: una vez
que el paciente confirma, el documento no debe poder editarse a sus espaldas.

El PDF se genera **una sola vez**, al final, cuando ya existen ambas firmas.

Las firmas son PNG en base64, demasiado grandes para viajar como parámetros de ruta, así
que las cinco pantallas comparten el `ConsentDraftProvider` montado en
`consent/_layout.tsx`. El borrador se descarta cada vez que la pantalla de selección
(`consent/index.tsx`) recibe el foco — al retroceder desde el formulario o al finalizar —
de modo que el siguiente paciente nunca empieza sobre los datos del anterior.

**Teclado.** Login y registro (formularios cortos y centrados) van dentro de
`components/common/KeyboardAvoidingScreen`. El formulario de diligenciamiento es distinto:
es un scroll largo y, al escribir el nombre, deben quedar visibles los campos siguientes y
el módulo de firma. Por eso, mientras el teclado está abierto, el contenido del scroll
recibe un `paddingBottom` igual a la altura del teclado (equivalente multiplataforma del
`automaticallyAdjustKeyboardInsets` de iOS) y el campo enfocado se desplaza hasta la parte
superior del área visible. Sin ese padding no hay contenido suficiente debajo del primer
campo para subirlo, el scroll se detiene en el tope y todo lo posterior queda bajo el
teclado — que es lo que ocurre en Android con edge-to-edge, donde la ventana no se
redimensiona al abrir el teclado.

### Plantillas de consentimiento

Una plantilla es un **documento JSON estructurado**, no un PDF ni un bloque de texto:

- **Encabezado**: `code`, `version`, `title`, `effectiveDate`.
- **Contenido**: `blocks[]` con cinco tipos — `heading` (3 niveles), `paragraph` (con
  `indent` 0–3 y énfasis), `list` (ordenada o con viñetas), `note` y `spacer`.
- **Campos**: `fields[]` — lo que se diligencia antes de firmar. `prefill:
  "professional.name"` llena el campo desde la sesión y lo bloquea.

  > La cuenta con sesión iniciada es la del **profesional que atiende**, no la del
  > paciente: un mismo dispositivo atiende a muchos pacientes durante un turno. Por eso
  > los datos del paciente (nombre, cédula) siempre se escriben a mano y `prefill` solo
  > ofrece datos del profesional.
- **Firmas**: `signatures[]` — cada una declara su `signer` (`patient` o `professional`),
  y eso es lo que decide en qué pantalla del flujo se captura.
- **Pie**: `footer[]` — la fila de cierre del documento, en una sola línea. Cada celda es
  `{ type: "signature", key }`, `{ type: "field", key }` o `{ type: "date" }`. En `CA-F-14`:
  firma del paciente · cédula · firma del profesional · fecha y hora. Si se omite, por
  defecto son todas las firmas seguidas de la fecha.

`templateSchema.ts` valida ese JSON venga de donde venga: hoy de una fila de SQLite, en
fase 2 del cuerpo de una respuesta HTTP del constructor web de plantillas.

Dos renderizadores consumen los mismos bloques y deben mantenerse sincronizados:
`ConsentDocument.tsx` (pantalla) y `documentHtml.ts` (PDF).

> Hay **dos fechas distintas** en el documento, y no deben confundirse:
>
> - El `FECHA` del encabezado es el `effectiveDate` de la plantilla — **la fecha de
>   creación de esa revisión del formato**. Es fija: idéntica en todos los documentos
>   generados a partir de la misma plantilla.
> - La fecha del pie es **la del acto de consentimiento** (fecha y hora actuales al
>   generar el PDF), y cambia en cada documento.

### Logo

`src/components/logos/acr-logo.png` es hoy un marcador de posición de 1×1 transparente.
Reemplázalo por el logo real con el mismo nombre y todo lo demás funciona: el encabezado
en pantalla y el del PDF lo toman automáticamente. Ver
[`src/components/logos/README.md`](../src/components/logos/README.md).

## Correr el proyecto localmente

```bash
npm install
npm start
```

Esto levanta el bundler de Metro y el menú interactivo de Expo CLI. Desde ahí puedes:
- Presionar `a` para abrir en un emulador Android.
- Presionar `i` para abrir en un simulador iOS (solo macOS).
- Presionar `w` para abrir la versión web.
- Escanear el QR con la app **Expo Go** en tu teléfono.

### Credenciales de prueba

La base local se siembra con un usuario (ver `services/localDb.ts`):

```
paciente@acrvitallaboral.com / consentimiento123
```

También puedes registrar cuentas nuevas desde `register.tsx`; quedan en la misma tabla
`users` de SQLite.

## API gateway y registro de auditoría

Las peticiones salen por `services/apiClient.ts` hacia el API gateway. Mientras el gateway
no exista, el cliente corre en **modo dry-run**: imprime en consola el método, la URL, las
cabeceras y el cuerpo exacto que enviaría, y devuelve `{ status: 'skipped' }`. Al definir
`EXPO_PUBLIC_API_URL` las mismas llamadas empiezan a salir de verdad, sin tocar código.

Toda la configuración vive en variables `EXPO_PUBLIC_*` (ver `.env.example`; `.env` trae
los valores por defecto con la URL vacía). Se leen en un solo lugar,
`services/api/config.ts`, porque Expo solo reemplaza `process.env.EXPO_PUBLIC_NOMBRE`
cuando se escribe literal — nada de `process.env[clave]` ni desestructuración. Recuerda que
esos valores viajan en texto plano dentro del bundle: endpoints y la API key pública del
gateway sí, credenciales de firma nunca.

| Variable | Para qué |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | Origen del gateway. Vacío = dry-run. |
| `EXPO_PUBLIC_API_KEY` | Se envía como `x-api-key` si el stage lo exige. |
| `EXPO_PUBLIC_API_TIMEOUT_MS` | Timeout de las peticiones (15000 por defecto). |
| `EXPO_PUBLIC_API_LOG` | Imprime cada payload y cada respuesta. |
| `EXPO_PUBLIC_AUTH_LOGIN_PATH` / `..._REGISTER_PATH` / `..._REFRESH_PATH` / `EXPO_PUBLIC_AUDIT_LOGS_PATH` | Rutas relativas al origen. |
| `EXPO_PUBLIC_PDF_UPLOAD_URL_PATH` | Ruta que firma la subida. `{consent_id}` se sustituye en cada petición. |
| `EXPO_PUBLIC_AUTH_MODE` | `remote`, `local` o `auto`. |
| `EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS` | Vigencia del token (12). La app renueva al 90 % de ese tiempo. |
| `EXPO_PUBLIC_CLINIC_LOCATION_ID`, `EXPO_PUBLIC_DEFAULT_ID_TYPE`, `EXPO_PUBLIC_MEDICAL_EXAM_TYPE` | Identidad del despliegue, estampada en cada log. |
| `EXPO_PUBLIC_PDF_S3_BUCKET` / `EXPO_PUBLIC_PDF_S3_PREFIX` | Dónde quedará el PDF firmado. |

### Login y registro

`features/auth/services/authApi.ts` pega contra el gateway y, en modo `auto`, cae a la
tabla `users` de SQLite cuando no hay endpoint configurado o no se pudo alcanzar. Una
respuesta real del backend ("contraseña incorrecta", "correo ya registrado") **no** se
reintenta contra la base local: la respuesta del servidor manda. `normalizeAuthResponse`
es el único punto a ajustar cuando el contrato real esté definido.

La sesión se renueva sola: al 90 % de `EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS`, al volver la app
al primer plano, y ante cualquier `401` — en ese caso `apiClient.ts` renueva y **reintenta
la petición una vez**, de forma transparente para la pantalla que la lanzó. Varias
renovaciones simultáneas se agrupan en una sola. Si la renovación falla, se cierra la sesión.

La comprobación es periódica en vez de un temporizador largo a propósito: una tablet pasa la
mayor parte del turno suspendida y los temporizadores de JS no se disparan de forma fiable en
segundo plano.

### Log `CONSENT_SIGNED`

Al firmar el profesional, `professional.tsx` genera el PDF y acto seguido arma el ítem de
auditoría (`features/audit/`) y lo entrega al servicio. Nunca bloquea ni puede tumbar la
firma: el envío corre sin `await`, no lanza excepciones, y lo que no se pudo entregar queda
en un outbox en memoria (`pendingAuditLogs()` / `flushPendingAuditLogs()`). La pantalla
final muestra si el registro salió, quedó pendiente o falló.

El backend lo guarda como objeto inmutable en S3 (`events/<consent_id>/0001-CONSENT_SIGNED.json`,
Object Lock 365 días; los campos `PK`/`SK`/`GSI*` que aún envía la app se ignoran), e incluye:

- `signature_data`: las huellas del documento.
  - **`pdf_sha256` es la que importa para no repudio**: SHA-256 de los bytes del PDF final,
    tomado de los mismos bytes que se escriben en disco. Es exactamente lo que devuelve
    `sha256sum consent.pdf`, así que cualquiera puede verificar el archivo archivado sin
    volver a renderizar nada — cosa que además nunca coincidiría, porque el motor de
    impresión del sistema estampa su propia fecha de creación en cada PDF.
  - `document_hash_sha256`: SHA-256 del HTML del que se renderizó ese PDF (la entrada del
    render, no el artefacto).
  - `template_hash_sha256`: SHA-256 de la plantilla JSON, para detectar texto que cambió
    sin subir `document_version`.
  - `image_sha256`: SHA-256 del payload base64 de la firma PNG.
- `biometrics_json`: cada punto `(x, y, p, t)` de cada trazo. La captura la hace
  `consent/services/signatureBiometrics.ts`: el `signature_pad` que trae la librería solo
  guarda x/y/tiempo, así que se inyecta un script en el WebView que escucha PointerEvents y
  obtiene además la presión del stylus. Sin stylus, `device_pressure_supported` queda en
  `false`.
- `capture_metadata`: quién atendió, cuánto tardó el paciente leyendo y si llegó al final
  del documento (`time_spent_reading_sec`, `has_scrolled_to_bottom`).
- `device_context`: marca, modelo, SO y resolución, más `utc_offset_minutes` (el documento
  imprime la fecha en hora local y el log la guarda en UTC; sin el desfase no se puede
  re-derivar lo que quedó impreso). `ip_address` va en `null` a propósito — el gateway debe
  estamparla desde el contexto de la petición.

### Envío del consentimiento

Justo después de generar el PDF, `consentSubmitService.ts` envía **en una sola llamada**
el log y el PDF (`POST /consents`, PDF en base64). El backend comprueba que el PDF es el
que el log dice, lo guarda con verificación de checksum de S3, escribe los dos eventos de
evidencia y responde con sus hashes. No hay URL firmada ni subida directa a S3.

```
generar PDF → POST /consents { log, pdf_base64 } → 201 { pdf.key, events.* }
```

Si no hay red, el consentimiento (log + PDF) queda en `<documentos>/outbox/` y se reenvía
solo: al abrir la app, al volver a primer plano y al enviar el siguiente. Un rechazo
definitivo del servidor (4xx) se mueve a `outbox/rejected/` y se muestra en la pantalla
final.

## Notas de fase 1

- **El log de firma ya se arma; falta a dónde enviarlo.** El ítem `CONSENT_SIGNED` se
  construye completo y se imprime en consola en cada firma. Sin `EXPO_PUBLIC_API_URL` no
  sale del dispositivo y el outbox se pierde al reiniciar la app; persistirlo en SQLite es
  el paso natural cuando exista el endpoint.
- **El PDF se genera y queda en el dispositivo.** `pdfService.ts` lo escribe en
  `Paths.cache/consents/` y lo entrega por la hoja de compartir del sistema. Ese punto es
  exactamente la costura que en fase 2 se convierte en `StorageService.putObject()`.
- **Por qué base64 y no mover el archivo.** `expo-print` escribe en la caché cruda de la
  app (`cache/Print/<uuid>.pdf`). Bajo Expo Go esa ruta queda fuera del sandbox, y tanto
  `expo-sharing` como `expo-file-system` consultan el mismo `FilePermissionService`, así
  que ninguno puede leerla. Por eso se piden los bytes a `expo-print`
  (`base64: true`, que no pasa por el sistema de archivos) y se escriben en un archivo
  propio dentro de `Paths.cache`.
- **La contraseña se compara en texto plano.** Aceptable para un stand-in local; jamás
  para el backend real.
- **La fecha viene del reloj del dispositivo.** En fase 2 debe venir del servidor, para
  que un equipo con la hora mal no pueda fechar mal una historia clínica.

## Próximos pasos sugeridos

- Implementar la rama de **DESISTIMIENTO** (página 3 de `CA-F-14`): un segundo conjunto de
  bloques y un selector Aceptar/Desistir en la pantalla 1. El flujo, el borrador y el
  pipeline de PDF ya lo soportan sin cambios.
- Persistir la sesión (`token`/`user` de `authStore.ts`) entre reinicios, por ejemplo con
  `expo-secure-store`.
- Definir `EXPO_PUBLIC_API_URL` para que `services/apiClient.ts` apunte al gateway real, y
  ajustar `normalizeAuthResponse` al contrato de autenticación definitivo.
- Persistir el outbox de auditoría en SQLite y reintentarlo al recuperar conexión.
- Subir el PDF firmado al bucket para que `pdf_s3_key` deje de ser una predicción.
- Reemplazar el logo de marcador de posición en `src/components/logos/`.
- Agregar assets reales (`icon`, `splash`, `adaptive-icon`) en `app.json` antes de un
  build de producción con EAS.

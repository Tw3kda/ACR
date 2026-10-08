# Plantillas de consentimiento — guía de administración

Los formularios de consentimiento (CA-F-14, …) **no van dentro del APK**: se publican en AWS
y las tablets los descargan. Crear un formulario nuevo o cambiar el texto de uno existente
**no requiere** compilar ni reinstalar la app.

| | |
|---|---|
| Archivos fuente | `API GATEWAY/templates/<CÓDIGO>.json` (se versionan en git) |
| Herramienta | `API GATEWAY/scripts/publish-template.mjs` |
| Dónde quedan | bucket de evidencia `medical-consent-evidence-781485980004`, carpeta `templates/` |
| Quién los sirve | `GET /templates` y `GET /templates/{code}` del API (requieren sesión) |
| Quién los usa | la app de la tablet, al abrir la lista de consentimientos |

---

## 1. Cómo funciona (en 30 segundos)

```
templates/CA-F-15.json ──publish──► Lambda del API ──► S3  templates/CA-F-15/1.0.json      (la plantilla, inmutable)
        (tu PC)          (IAM)                         S3  templates/_catalog/00000005.json (qué está activo)
                                                                   │
tablet ── abre "Consentimientos" ──► GET /templates ◄──────────────┘
```

- **Una versión publicada no se puede modificar ni borrar** (Object Lock + escritura única).
  Para cambiar un texto se publica una versión nueva.
- **El catálogo** (qué formularios ven las tablets) es una serie de fotos numeradas: cada
  publicación o retiro escribe una nueva con quién y cuándo. La de número más alto manda.
  Es el historial completo de cambios.
- **Cada consentimiento firmado** guarda qué plantilla y versión usó, y el servidor añade el
  SHA-256 de la plantilla publicada (`template_ref`). La web de consulta lo muestra como
  *Plantilla verificada*.
- **Sin internet**, la tablet usa la última lista que descargó; si nunca tuvo conexión, el
  CA-F-14 que viene dentro del APK.

---

## 2. Requisitos (una sola vez)

1. **AWS CLI** con credenciales de la cuenta `781485980004` y permiso
   `lambda:InvokeFunction` sobre `medical-consent-api` (el usuario `Development` lo tiene).
   Comprobar: `aws sts get-caller-identity`
2. **Node.js 20+** y el repositorio con `npm install` hecho en `API GATEWAY/`.
3. Ejecutar los comandos **desde la carpeta `API GATEWAY/`**.

> En Git Bash de Windows, si un comando falla con rutas tipo `C:/Program Files/Git/...`,
> antepón `MSYS_NO_PATHCONV=1`. En PowerShell no hace falta.

---

## 3. Formato de una plantilla

Ejemplo completo y real: [`templates/CA-F-14.json`](../templates/CA-F-14.json). Lo más fácil
es copiarlo y editarlo.

```jsonc
{
  "code": "CA-F-15",                    // identificador; letras, números, . _ -
  "version": "1.0",                     // se sube en cada cambio: 1.0 → 1.1 → 1.2 …
  "title": "Consentimiento informado — Audiometría",
  "examType": "AUDIOMETRIA",            // MAYÚSCULAS_CON_GUIONES_BAJOS; va al registro como tipo de examen
  "effectiveDate": "2026-10-06",        // fecha de esta revisión; se imprime en el encabezado
  "blocks": [ … ],                      // el texto del documento, en orden
  "fields": [ … ],                      // lo que se escribe antes de firmar
  "signatures": [ … ],                  // quién firma
  "footer": [ … ]                       // fila de cierre (opcional)
}
```

**`blocks`** — el texto:

| Tipo | Campos | Ejemplo |
|---|---|---|
| `heading` | `text`, `level` (1–3) | `{ "type": "heading", "level": 2, "text": "Beneficios" }` |
| `paragraph` | `text`, `indent` (0–3), `emphasis` (`bold`/`italic`) | `{ "type": "paragraph", "text": "…" }` |
| `list` | `items` (lista de textos), `ordered`, `indent` | `{ "type": "list", "ordered": true, "items": ["…", "…"] }` |
| `note` | `text` (recuadro destacado) | `{ "type": "note", "text": "Al firmar…" }` |
| `spacer` | — (espacio en blanco) | `{ "type": "spacer" }` |

**`fields`** — datos que se escriben antes de firmar:

```json
{ "key": "cedula", "label": "Cédula del paciente", "input": "number", "required": true, "placeholder": "Número de identificación" }
```

- `input`: `text` o `number`. `required` es `true` si se omite.
- `prefill`: `professional.name` o `professional.email` para rellenar con el profesional de la sesión.
- **Usa `nombre` y `cedula` como claves** del paciente: son las que el registro de auditoría
  reconoce como nombre y documento.

**`signatures`** — al menos una:

```json
{ "key": "patient", "label": "Firma del paciente", "signer": "patient" }
```

`signer`: `patient` o `professional`. Primero firma el paciente y luego se entrega la tablet
al profesional.

**`footer`** — la fila final del formulario en papel (si se omite: todas las firmas y la fecha):

```json
[ { "type": "signature", "key": "patient" }, { "type": "field", "key": "cedula" },
  { "type": "signature", "key": "professional" }, { "type": "date", "label": "Fecha y hora" } ]
```

**`decision`** (opcional) — paso de **aceptar / rechazar** antes de firmar:

```json
"decision": {
  "prompt": "¿Autoriza la toma de muestras descrita en este documento?",
  "accept":  { "label": "Acepto",    "blocks": [ { "type": "note", "text": "Al firmar este documento declaro que … doy mi consentimiento y firmo." } ] },
  "decline": { "label": "No acepto", "blocks": [ { "type": "note", "text": "…texto de rechazo aprobado por la clínica…" } ] }
}
```

El paciente lee el documento, elige una opción y el texto de esa opción se añade al final
del documento; después llena los campos y firma. **El rechazo también se firma** y se guarda
con su PDF como `CONSENT_DECLINED`; la web de consulta lo marca *Rechazado*. Si cambia de
opción, la firma se borra y debe firmar de nuevo. Sin `decision`, el formulario solo se
puede aceptar (como CA-F-14 v1.0). Requiere la versión de la app con este paso.

Formularios publicados con este paso (2026-10-06): **CA-F-14 v1.1**, **CA-F-15 v1.0** y
**CA-F-35 v1.0**, transcritos de los formatos en PDF. El texto de *No acepto* es el
**DESISTIMIENTO** de los formatos (CA-F-35 no lo trae en papel; se usa el mismo con
aprobación de la clínica). Se generan con `templates/borradores/build-drafts.mjs`, que
escribe `templates/<CÓDIGO>.json`; si cambias un texto ahí, sube la versión antes de
regenerar y publicar.

> Las claves de `fields` y `signatures` no se pueden repetir, y el `footer` solo puede
> referirse a claves que existan. Un tipo de bloque o de campo que no esté en estas tablas
> requiere actualizar la app (APK); una app antigua simplemente ignora ese formulario.

---

## 4. Comandos (CRUD)

### Validar sin publicar (no toca AWS)

```bash
node scripts/publish-template.mjs check templates/CA-F-15.json
```

Muestra el resumen o el error exacto (`Plantilla inválida: footer referencia la firma inexistente "testigo"`).

### Crear — publicar un formulario nuevo

```bash
node scripts/publish-template.mjs publish templates/CA-F-15.json
```

Valida, muestra el resumen y pide confirmación (`--yes` para no preguntar). Queda **activo**:
las tablets lo ven la próxima vez que abren la lista (≤ 1 minuto).

Para dejarlo guardado **sin ofrecerlo todavía**:

```bash
node scripts/publish-template.mjs publish templates/CA-F-15.json --no-activate
```

Y para activarlo después, el mismo comando sin `--no-activate` (no crea nada nuevo, solo activa).

### Leer — ver lo que hay

```bash
# Lo que ven las tablets ahora
node scripts/publish-template.mjs list

# Todas las versiones guardadas de un formulario
aws s3 ls s3://medical-consent-evidence-781485980004/templates/CA-F-14/

# El contenido exacto de una versión
aws s3 cp s3://medical-consent-evidence-781485980004/templates/CA-F-14/1.0.json -

# Historial de cambios del catálogo (cada archivo = una publicación o un retiro)
aws s3 ls s3://medical-consent-evidence-781485980004/templates/_catalog/
aws s3 cp s3://medical-consent-evidence-781485980004/templates/_catalog/00000001.json -
```

### Actualizar — cambiar el texto de un formulario

1. Edita `templates/CA-F-15.json`.
2. **Sube `version`** (`"1.0"` → `"1.1"`) y actualiza `effectiveDate`.
3. Publica:
   ```bash
   node scripts/publish-template.mjs publish templates/CA-F-15.json
   ```
4. Haz commit del archivo.

La 1.1 pasa a ser la activa. La 1.0 sigue guardada y los consentimientos firmados con ella
siguen apuntando a su texto exacto. Una tablet que estaba llenando la 1.0 la termina con la 1.0.

> **¿Error en una versión ya publicada?** No se puede corregir: publica la siguiente (1.2).
> Si intentas publicar la misma versión con otro contenido, el script responde
> *«ya está publicada con otro contenido. Suba el número de versión»*.

### Volver a una versión anterior (rollback)

Recupera el archivo de esa versión (desde git, o con el `aws s3 cp` de arriba a un archivo) y
publícalo:

```bash
git show <commit>:"API GATEWAY/templates/CA-F-15.json" > /tmp/CA-F-15-v1.0.json
node scripts/publish-template.mjs publish /tmp/CA-F-15-v1.0.json
```

Como esa versión ya existe con el mismo contenido, no se escribe nada nuevo: solo vuelve a
ser la activa.

### Borrar — retirar un formulario

```bash
node scripts/publish-template.mjs retire CA-F-15
```

Deja de aparecer en las tablets. **No se borra nada**: sus versiones siguen guardadas (los
consentimientos ya firmados las necesitan) y puede reactivarse publicándolo de nuevo.
Borrar de verdad no es posible por diseño (Object Lock).

---

## 5. ¿Se puede hacer desde la consola de AWS?

**Sí, con la Lambda. No, editando los archivos en S3.**

### S3 — solo lectura

En **S3 → `medical-consent-evidence-781485980004` → `templates/`** puedes ver y descargar
cualquier plantilla y el historial `_catalog/`. **No puedes subir ni reemplazar archivos**: la
política del bucket solo deja escribir al rol del API, y solo una vez por nombre. Es
intencional: nadie (ni un administrador) puede cambiar en silencio un texto que ya firmaron
pacientes. Un intento de subida responde *Access Denied*.

### Lambda → pestaña «Test» — publicar, listar y retirar

1. **Lambda → Functions → `medical-consent-api` → pestaña *Test*.**
2. *Create new event*, ponle un nombre (`listar-plantillas`), deja *Private*.
3. Pega uno de estos JSON en *Event JSON*, *Save* y luego **Test**.

**Listar:**

```json
{ "source": "acr.admin", "action": "listTemplates" }
```

**Publicar** (pega dentro de `"template"` el contenido completo del archivo `.json`):

```json
{
  "source": "acr.admin",
  "action": "publishTemplate",
  "actor": "consola: Nombre Apellido",
  "activate": true,
  "template": {
    "code": "CA-F-15",
    "version": "1.0",
    "title": "…",
    "examType": "AUDIOMETRIA",
    "effectiveDate": "2026-10-06",
    "blocks": [ … ],
    "fields": [ … ],
    "signatures": [ … ]
  }
}
```

**Retirar:**

```json
{ "source": "acr.admin", "action": "retireTemplate", "code": "CA-F-15", "actor": "consola: Nombre Apellido" }
```

El resultado aparece en *Execution results*: `{ "ok": true, "result": { … } }` o
`{ "ok": false, "status": 400, "message": "Plantilla inválida: …" }`. Las validaciones son
las mismas que las del script.

> Diferencias con el script: la consola **no pide confirmación** (al pulsar *Test* se
> publica) y el campo `actor` lo escribes tú — escribe tu nombre real, queda en el historial.
> Para cambios grandes es más seguro el script: valida el archivo local con `check` antes.

### AWS CloudShell

Desde la consola también puedes abrir **CloudShell** (icono `>_` arriba) y usar la CLI sin
instalar nada en tu PC. Por ejemplo, para listar:

```bash
echo '{"source":"acr.admin","action":"listTemplates"}' > ev.json
aws lambda invoke --function-name medical-consent-api --cli-binary-format raw-in-base64-out --payload fileb://ev.json out.json && cat out.json
```

Para publicar, sube el `.json` a CloudShell (*Actions → Upload file*) y arma el evento con
`jq`:

```bash
jq '{source:"acr.admin", action:"publishTemplate", actor:"cloudshell: Nombre", template:.}' CA-F-15.json > ev.json
aws lambda invoke --function-name medical-consent-api --cli-binary-format raw-in-base64-out --payload fileb://ev.json out.json && cat out.json
```

---

## 6. Qué ven las tablets y cuándo

| Situación | Qué pasa |
|---|---|
| Se publica o retira un formulario | Las tablets lo reflejan al **abrir la lista** de consentimientos, como mucho ~1 minuto después (caché del API). |
| La tablet no tiene internet | Usa la última lista descargada y muestra *«Sin conexión: mostrando los consentimientos descargados …»*. |
| Tablet recién instalada, sin internet nunca | Solo ofrece el CA-F-14 incluido en el APK y lo indica. |
| La plantilla usa algo que esa versión de la app no sabe dibujar | La app la omite y sigue mostrando las demás. Hay que actualizar el APK. |
| Se firma con una versión que nunca se publicó (copia del APK) | El consentimiento se guarda igual; la web lo marca *Plantilla no publicada*. |

---

## 7. Errores frecuentes

| Mensaje | Causa y solución |
|---|---|
| `Plantilla inválida: …` | El JSON no cumple el formato de la sección 3. El mensaje dice qué campo. Valida con `check`. |
| `ya está publicada con otro contenido. Suba el número de versión` | Cambiaste el texto sin subir `version`. |
| `Otro cambio del catálogo ocurrió al mismo tiempo` | Dos personas publicaron a la vez. Repite el comando. |
| `CA-F-15 no está activo` (al retirar) | Ya estaba retirado o el código está mal escrito. Mira `list`. |
| `aws lambda invoke falló: … AccessDenied` | Tus credenciales no pueden invocar la Lambda. Revisa `aws sts get-caller-identity`. |
| `No se pudo leer …` | Ruta del archivo incorrecta o JSON con una coma de más. |

---

## 8. Buenas prácticas

- **Siempre commit** del `.json` en `templates/` después de publicar: git es la copia
  editable; S3 es la copia oficial e inmutable.
- **El CA-F-14 incluido en la app** (`CONCENTIMIENTO_INFORMADO/src/features/consent/data/caF14.ts`)
  es solo el respaldo sin conexión. Si cambias el CA-F-14, actualízalo también en la
  próxima versión del APK.
- **Revisa el texto con la clínica antes de publicar**: lo publicado queda guardado de forma
  permanente, y cada consentimiento firmado queda ligado a esa versión exacta.
- Las plantillas **no caducan** (el borrado automático a los 366 días solo aplica a
  `events/`, `index/` y `access/`).

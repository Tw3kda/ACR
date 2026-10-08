/**
 * Prueba de humo end-to-end contra el handler de Lambda, no contra Express.
 *
 * Construye eventos de API Gateway HTTP API (payload 2.0) con la misma forma que
 * produce el gateway real —cuerpo como string, claims en
 * requestContext.authorizer.jwt.claims, sourceIp, timeEpoch— y recorre el flujo
 * completo: login -> POST /consents (log + PDF) -> reenvío duplicado ->
 * rechazos (hash distinto, PDF falso, colisión de id).
 *
 *   node scripts/smoke.js
 */
import crypto from 'node:crypto';

process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'warn';
process.env.REGISTRATION_ENABLED ??= 'true';
process.env.AUTH_READER_GROUP ??= 'auditores';

const { handler: api } = await import('../src/handlers/api.js');

const CONSENT_ID = 'CONS-2026-0831-042';
const PATIENT_ID = '1018293847';
const TIMESTAMP = '2026-08-31T20:15:30.123Z';
// Un PDF mínimo pero real: cabecera, un objeto, fin. El servicio exige la
// firma "%PDF-" y un tamaño mínimo; lo demás no lo mira.
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n'),
  Buffer.alloc(1500, 0x20),
  Buffer.from('\n%%EOF\n'),
]);
const PDF_SHA256 = crypto.createHash('sha256').update(PDF_BYTES).digest('hex');
const PDF_B64 = PDF_BYTES.toString('base64');
const consentBody = (log = auditPayload(), pdf = PDF_B64) => ({ log, pdf_base64: pdf });

let failures = 0;

function check(name, condition, extra) {
  const mark = condition ? 'ok  ' : 'FALLA';
  console.log(`${mark} ${name}${condition || extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  if (!condition) failures += 1;
}

function event(method, pathAndQuery, body, { claims = null, headers = {} } = {}) {
  const [path, query = ''] = pathAndQuery.split('?');
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: query,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'smoke',
      domainName: 'smoke.execute-api.us-east-1.amazonaws.com',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '190.85.12.34', userAgent: 'smoke' },
      requestId: crypto.randomUUID(),
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: TIMESTAMP,
      timeEpoch: Date.parse(TIMESTAMP),
      ...(claims ? { authorizer: { jwt: { claims, scopes: null } } } : {}),
    },
  };
}

const call = async (...args) => {
  const res = await api(event(...args), { callbackWaitsForEmptyEventLoop: true });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};

function auditPayload() {
  return {
    PK: `PATIENT#${PATIENT_ID}`,
    SK: `LOG#${TIMESTAMP}#${CONSENT_ID}`,
    GSI1_PK: 'CLINIC#SEDE_NORTE_01',
    GSI1_SK: `LOG#${TIMESTAMP}`,
    log_id: '8f3b2a1c-5d4e-4f6a-9b8c-1e2f3a4b5c6d',
    consent_id: CONSENT_ID,
    timestamp_utc: TIMESTAMP,
    event_type: 'CONSENT_SIGNED',
    subject: {
      patient_id: PATIENT_ID,
      id_type: 'CC',
      full_name: 'Nombre Del Paciente',
      medical_exam_type: 'EXAMEN_INGRESO_OCUPACIONAL',
    },
    signature_data: {
      signature_format: 'PNG_BASE64_HASH',
      image_sha256: crypto.createHash('sha256').update('firma').digest('hex'),
      stroke_count: 3,
      total_duration_ms: 3450,
      document_version: 'v1.0',
      document_hash_sha256: crypto.createHash('sha256').update('doc').digest('hex'),
      pdf_sha256: PDF_SHA256,
      template_hash_sha256: crypto.createHash('sha256').update('tpl').digest('hex'),
    },
    biometrics_json: {
      sampling_rate_hz: 62,
      total_duration_ms: 3450,
      device_pressure_supported: true,
      strokes: [{ stroke_index: 0, points: [{ x: 120.4, y: 210.1, p: 0.32, t: 0 }] }],
    },
    device_context: {
      device_brand: 'Samsung',
      device_model: 'SM-X706B',
      os_name: 'Android',
      os_version: '14',
      app_version: '1.0.0',
      screen_resolution: '2560x1600',
      utc_offset_minutes: -300,
      ip_address: null,
    },
    capture_metadata: {
      operator_id: 'seed-user-1',
      clinic_location_id: 'SEDE_NORTE_01',
      time_spent_reading_sec: 45,
      has_scrolled_to_bottom: true,
      pdf_s3_bucket: 'medical-consent-pdfs-bucket',
      pdf_s3_key: 'consents/2026/08/prediccion-del-dispositivo.pdf',
    },
  };
}

// --- 1. salud ---------------------------------------------------------------
const health = await call('GET', '/health');
check('GET /health responde 200', health.status === 200, health.body);

// --- 2. registro y login ----------------------------------------------------
const email = `smoke.${Date.now()}@acrvitallaboral.com`;
const registered = await call('POST', '/auth/register', {
  email,
  password: 'Smoke1234!',
  name: 'Dra. Ana Ruiz',
});
check('POST /auth/register devuelve 201 con sesión', registered.status === 201 && Boolean(registered.body.token));
check('el registro devuelve user.id', Boolean(registered.body.user?.id), registered.body.user);

const login = await call('POST', '/auth/login', { email, password: 'Smoke1234!' });
check('POST /auth/login devuelve 200 con token', login.status === 200 && Boolean(login.body.token));
check('POST /auth/login devuelve refreshToken', Boolean(login.body.refreshToken));

const badLogin = await call('POST', '/auth/login', { email, password: 'incorrecta' });
check('contraseña mala -> 401', badLogin.status === 401, badLogin.body);
check('mensaje genérico (no permite enumerar cuentas)',
  badLogin.body.message === 'Correo o contraseña incorrectos', badLogin.body);

const unknownUser = await call('POST', '/auth/login', { email: 'nadie@acrvitallaboral.com', password: 'x' });
check('usuario inexistente -> mismo mensaje que contraseña mala',
  unknownUser.status === 401 && unknownUser.body.message === badLogin.body.message);

// --- 3. refresh -------------------------------------------------------------
const refreshed = await call('POST', '/auth/refresh', { refresh_token: login.body.refreshToken });
check('POST /auth/refresh devuelve 200 con token', refreshed.status === 200 && Boolean(refreshed.body.token));

const badRefresh = await call('POST', '/auth/refresh', { refresh_token: 'basura' });
check('refresh inválido -> 401 (no 403)', badRefresh.status === 401, badRefresh.body);

// --- 4. el consentimiento: log + PDF en una llamada ------------------------------
const claims = { sub: login.body.user.id, email, token_use: 'access' };

const sinToken = await call('POST', '/consents', consentBody());
check('POST /consents sin claims -> 401', sinToken.status === 401, sinToken.body);

const created = await call('POST', '/consents', consentBody(), { claims });
check('POST /consents -> 201', created.status === 201, created.body);
check('devuelve consent_id, log_id, pdf.key y los hashes de los dos eventos',
  created.body.consent_id === CONSENT_ID && Boolean(created.body.log_id) &&
  created.body.pdf?.key === `consents/2026/08/${CONSENT_ID}.pdf` &&
  /^[0-9a-f]{64}$/.test(created.body.events?.signed_sha256 ?? '') &&
  /^[0-9a-f]{64}$/.test(created.body.events?.verified_sha256 ?? ''), created.body);
check('pdf.sha256 de la respuesta == sha256 de los bytes enviados', created.body.pdf?.sha256 === PDF_SHA256);

const duplicated = await call('POST', '/consents', consentBody(), { claims });
check('reenvío del outbox -> 200 duplicate (no 409)',
  duplicated.status === 200 && duplicated.body.duplicate === true, duplicated.body);
check('el reenvío devuelve los mismos hashes de evento',
  duplicated.body.events?.signed_sha256 === created.body.events?.signed_sha256 &&
  duplicated.body.events?.verified_sha256 === created.body.events?.verified_sha256);

// --- 5. lo que se rechaza sin escribir nada -------------------------------------------
const otroPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1500, 0x41)]).toString('base64');
const hashMismatch = await call('POST', '/consents',
  consentBody({ ...auditPayload(), consent_id: 'CONS-HASH-MAL', log_id: crypto.randomUUID() }, otroPdf), { claims });
check('PDF que no coincide con pdf_sha256 del log -> 400 pdf_hash_mismatch',
  hashMismatch.status === 400 && hashMismatch.body.code === 'pdf_hash_mismatch', hashMismatch.body);

const noPdf = await call('POST', '/consents',
  consentBody({ ...auditPayload(), consent_id: 'CONS-NO-PDF', log_id: crypto.randomUUID(),
    signature_data: { ...auditPayload().signature_data, pdf_sha256: crypto.createHash('sha256').update('x').digest('hex') } },
  Buffer.from('esto no es un pdf, pero es largo '.repeat(60)).toString('base64')), { claims });
check('contenido que no es PDF -> 400', noPdf.status === 400, noPdf.body);

const sinPdf = await call('POST', '/consents', { log: auditPayload() }, { claims });
check('sin pdf_base64 -> 400', sinPdf.status === 400, sinPdf.body);

const badEvent = await call('POST', '/consents', consentBody({ ...auditPayload(), event_type: 'CONSENT_VIEWED' }), { claims });
check('event_type distinto de CONSENT_SIGNED -> 400', badEvent.status === 400, badEvent.body);

const badHash = await call('POST', '/consents',
  consentBody({ ...auditPayload(), consent_id: 'CONS-OTRO', signature_data: { ...auditPayload().signature_data, pdf_sha256: 'xyz' } }), { claims });
check('pdf_sha256 mal formado -> 400', badHash.status === 400, badHash.body);

const traversal = await call('POST', '/consents', consentBody({ ...auditPayload(), consent_id: '../../etc/passwd' }), { claims });
check('consent_id con path traversal se rechaza', traversal.status === 400, traversal.body);

// La firma ya no entra por /audit/logs: un CONSENT_SIGNED sin PDF no es un consentimiento.
const viejaRuta = await call('POST', '/audit/logs', auditPayload(), { claims });
check('POST /audit/logs con CONSENT_SIGNED -> 400 (usar /consents)', viejaRuta.status === 400, viejaRuta.body);

// Nada de lo anterior debe haber dejado rastro.
const evidenceStub = await import('../src/aws/evidence.stub.js');
const s3Stub = await import('../src/aws/s3.stub.js');
check('los rechazos no escribieron eventos',
  ![...evidenceStub.__store.keys()].some((k) => /CONS-HASH-MAL|CONS-NO-PDF|CONS-OTRO/.test(k)), [...evidenceStub.__store.keys()]);
check('los rechazos no escribieron PDFs',
  ![...s3Stub.__store.keys()].some((k) => /CONS-HASH-MAL|CONS-NO-PDF|CONS-OTRO/.test(k)), [...s3Stub.__store.keys()]);

// --- 6. lo que quedó escrito -----------------------------------------------------------
const signed = await evidenceStub.getEvent(CONSENT_ID, 1, 'CONSENT_SIGNED');
const stored = signed?.event?.payload;
check('el evento 0001-CONSENT_SIGNED existe', Boolean(signed), signed);
check('sobre del evento: schema, seq 1, prev_hash null',
  signed?.event?.schema === 'acr.consent.event/1' && signed?.event?.seq === 1 && signed?.event?.prev_hash === null, signed?.event);
check('ip_address la pone el gateway', stored?.device_context?.ip_address === '190.85.12.34', stored?.device_context?.ip_address);
check('operator_id lo pone el token', stored?.capture_metadata?.operator_id === claims.sub, stored?.capture_metadata?.operator_id);
check('received_at_utc viene del reloj del gateway', stored?.received_at_utc === TIMESTAMP, stored?.received_at_utc);
check('pdf_s3_key del evento es la clave real, no la predicción del dispositivo',
  stored?.capture_metadata?.pdf_s3_key === `consents/2026/08/${CONSENT_ID}.pdf`, stored?.capture_metadata?.pdf_s3_key);
check('las llaves de DynamoDB no se guardan', stored?.PK === undefined && stored?.GSI2_PK === undefined);
const pointers = [...evidenceStub.__store.keys()].filter((k) => k.startsWith('index/'));
check('tres punteros de índice: paciente, sede, fecha',
  pointers.some((k) => k.startsWith(`index/patient/${PATIENT_ID}/`)) &&
  pointers.some((k) => k.startsWith('index/clinic/')) &&
  pointers.some((k) => k.startsWith('index/date/2026/08/31/')), pointers);

const pdfStored = s3Stub.__store.get(`consents/2026/08/${CONSENT_ID}.pdf`);
check('el PDF quedó en el bucket con su checksum en base64',
  pdfStored?.checksumBase64 === Buffer.from(PDF_SHA256, 'hex').toString('base64') && pdfStored?.sizeBytes === PDF_BYTES.length, pdfStored);

const verifiedEvent = await evidenceStub.getEvent(CONSENT_ID, 2, 'PDF_VERIFIED');
check('existe el evento 0002-PDF_VERIFIED con verified=true', verifiedEvent?.event?.payload?.verified === true, verifiedEvent?.event);
check('0002 registra el checksum que S3 guardó == el del log',
  verifiedEvent?.event?.payload?.checksum_sha256 === PDF_SHA256 && verifiedEvent?.event?.payload?.registered_sha256 === PDF_SHA256);
check('la cadena: prev_hash de 0002 == sha256 de los bytes de 0001',
  verifiedEvent?.event?.prev_hash === signed?.sha256, { prev: verifiedEvent?.event?.prev_hash, sha: signed?.sha256 });
check('la respuesta del API dio exactamente esos hashes',
  created.body.events.signed_sha256 === signed?.sha256 && created.body.events.verified_sha256 === verifiedEvent?.sha256);

// Mismo consent_id, otro log_id, mismo PDF: la clave es el id, así que es un conflicto.
const colision = await call('POST', '/consents', consentBody({ ...auditPayload(), log_id: crypto.randomUUID() }), { claims });
check('otro log bajo el mismo consent_id -> 409', colision.status === 409, colision.body);

// Mismo consent_id, otro PDF: se detecta antes de tocar el evento.
const otroDoc = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1500, 0x42)]);
const colisionPdf = await call('POST', '/consents', consentBody(
  { ...auditPayload(), signature_data: { ...auditPayload().signature_data, pdf_sha256: crypto.createHash('sha256').update(otroDoc).digest('hex') } },
  otroDoc.toString('base64')), { claims });
check('otro PDF bajo el mismo consent_id -> 409 pdf_conflict',
  colisionPdf.status === 409 && colisionPdf.body.code === 'pdf_conflict', colisionPdf.body);

// --- 7. web de consulta: búsqueda, PDF, registro de accesos ---------------------------
const auditor = { ...claims, 'cognito:groups': '[auditores]' }; // como lo entrega el gateway
const sinGrupo = { ...claims, 'cognito:groups': '[profesionales]' };

let r = await call('POST', '/audit/search', { patient_id: PATIENT_ID }, { claims: auditor });
check('search: 200 con el consentimiento', r.status === 200 && r.body.items?.length === 1 && r.body.items[0].consent_id === CONSENT_ID, r.body);
check('search: sin biometrics_json', r.body.items?.[0]?.log && r.body.items[0].log.biometrics_json === undefined);
check('search: pdf verificado y cadena de 2 eventos', r.body.items?.[0]?.pdf?.verified === true && r.body.items[0].events?.length === 2, r.body.items?.[0]);

r = await call('POST', '/audit/search', { patient_id: PATIENT_ID }, { claims: sinGrupo });
check('search: 403 sin grupo (no 401)', r.status === 403, r.body);
r = await call('POST', '/audit/search', { patient_id: '12/../x' }, { claims: auditor });
check('search: 400 cédula inválida', r.status === 400, r.body);
r = await call('POST', '/audit/search', { patient_id: '99999999' }, { claims: auditor });
check('search: cédula sin registros -> 200 vacío', r.status === 200 && r.body.items.length === 0, r.body);

r = await call('GET', `/consents/${CONSENT_ID}/pdf-download-url`, undefined, { claims: auditor });
check('pdf-download-url: 200 con url y attachment', r.status === 200 && decodeURIComponent(r.body.url ?? '').includes('attachment'), r.body);
check('pdf-download-url: sha256 del PDF', r.body.pdf_sha256 === PDF_SHA256, r.body);
r = await call('GET', '/consents/NO-EXISTE/pdf-download-url', undefined, { claims: auditor });
check('pdf-download-url: 404 si no existe', r.status === 404, r.body);
r = await call('GET', `/consents/${CONSENT_ID}/pdf-download-url`, undefined, { claims: sinGrupo });
check('pdf-download-url: 403 sin grupo', r.status === 403, r.body);

r = await call('POST', '/audit/search', { patient_id: PATIENT_ID, kind: 'access' }, { claims: auditor });
const accessTypes = (r.body.items ?? []).map((i) => i.event_type);
check('access: solo la descarga queda registrada (las búsquedas no)',
  r.status === 200 && accessTypes.join() === 'PDF_DOWNLOADED', accessTypes);
check('access: registra operador e IP', r.body.items?.[0]?.operator_id === claims.sub && r.body.items[0].ip_address === '190.85.12.34', r.body.items?.[0]);

// Pacientes del día: el consentimiento del smoke es del 2026-08-31 20:15Z.
r = await call('POST', '/patients/today', { from: '2026-08-31T05:00:00.000Z', to: '2026-09-01T05:00:00.000Z' }, { claims: auditor });
check('today: el paciente del día con nombre y 1 consentimiento',
  r.status === 200 && r.body.items?.length === 1 && r.body.items[0].patient_id === PATIENT_ID &&
  r.body.items[0].full_name === 'Nombre Del Paciente' && r.body.items[0].consents === 1, r.body);
r = await call('POST', '/patients/today', { from: '2026-09-01T05:00:00.000Z', to: '2026-09-02T05:00:00.000Z' }, { claims: auditor });
check('today: otro día -> vacío', r.status === 200 && r.body.items?.length === 0, r.body);
r = await call('POST', '/patients/today', { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }, { claims: auditor });
check('today: rango de más de 48 h -> 400', r.status === 400, r.body);
r = await call('POST', '/patients/today', { from: 'x', to: 'y' }, { claims: sinGrupo });
check('today: 403 sin grupo', r.status === 403, r.body);

r = await call('POST', '/patients/suggest', { q: '8293' }, { claims: auditor });
check('suggest: coincidencia parcial (en medio de la cédula)',
  r.status === 200 && r.body.items?.[0]?.patient_id === PATIENT_ID && r.body.items[0].full_name === 'Nombre Del Paciente', r.body);
r = await call('POST', '/patients/suggest', { q: '555' }, { claims: auditor });
check('suggest: sin coincidencias -> vacío', r.status === 200 && r.body.items?.length === 0, r.body);
r = await call('POST', '/patients/suggest', { q: '10' }, { claims: auditor });
check('suggest: menos de 3 caracteres -> 400', r.status === 400, r.body);
r = await call('POST', '/patients/suggest', { q: 'nombre del' }, { claims: auditor });
check('suggest: por nombre',
  r.status === 200 && r.body.items?.[0]?.patient_id === PATIENT_ID && r.body.items[0].matched_by === 'name', r.body);
r = await call('POST', '/patients/suggest', { q: 'PACIENTE  nómbre' }, { claims: auditor });
check('suggest: nombre sin importar tildes, mayúsculas ni orden', r.status === 200 && r.body.items?.[0]?.patient_id === PATIENT_ID, r.body);
r = await call('POST', '/patients/suggest', { q: 'nombre inexistente' }, { claims: auditor });
check('suggest: nombre sin coincidencias -> vacío', r.status === 200 && r.body.items?.length === 0, r.body);
r = await call('POST', '/patients/suggest', { q: 'a b' }, { claims: auditor });
check('suggest: nombre con menos de 3 letras -> 400', r.status === 400, r.body);

// --- 8. plantillas: publicar, servir, versionar, retirar ---------------------------------
const { readFileSync } = await import('node:fs');
// El contenido real de templates/CA-F-14.json, fijado en 1.0 para que las pruebas de
// versionado no dependan de qué versión tenga el archivo hoy.
const CA_F_14 = { ...JSON.parse(readFileSync(new URL('../templates/CA-F-14.json', import.meta.url), 'utf8')), version: '1.0' };
const admin = (action, extra = {}) => api({ source: 'acr.admin', action, actor: 'smoke', ...extra }, {});
r = await admin('reindexNames');
check('admin: reindexNames reescribe el índice de nombres (idempotente)', r.ok === true && r.result.reindexed >= 1, r);

let a = await admin('publishTemplate', { template: CA_F_14 });
check('admin: publicar CA-F-14 v1.0', a.ok && a.result.created && a.result.active?.[0]?.code === 'CA-F-14', a);
a = await admin('publishTemplate', { template: CA_F_14 });
check('admin: republicar lo mismo es inofensivo', a.ok && a.result.created === false, a);
a = await admin('publishTemplate', { template: { ...CA_F_14, title: 'Otro texto' } });
check('admin: misma versión con otro contenido -> 409', !a.ok && a.status === 409, a);
a = await admin('publishTemplate', { template: { ...CA_F_14, signatures: [] } });
check('admin: plantilla inválida -> 400', !a.ok && a.status === 400, a);
a = await admin('borrarTodo');
check('admin: acción desconocida -> rechazada', !a.ok && a.status === 400, a);

r = await call('GET', '/templates', undefined, { claims });
check('GET /templates: catálogo con CA-F-14 v1.0 y examType', r.status === 200 && r.body.templates?.[0]?.version === '1.0' && r.body.templates[0].examType === 'TOMA_DE_MUESTRAS', r.body);
r = await call('GET', '/templates');
check('GET /templates sin sesión -> 401', r.status === 401, r.body);
r = await call('GET', '/templates/CA-F-14', undefined, { claims });
check('GET /templates/CA-F-14: plantilla completa + sha256', r.status === 200 && r.body.template?.blocks?.length === CA_F_14.blocks.length && /^[0-9a-f]{64}$/.test(r.body.sha256 ?? ''), r.body);
const sha10 = r.body.sha256;

a = await admin('publishTemplate', { template: { ...CA_F_14, version: '1.1', title: 'Toma de muestras (rev. 1.1)' } });
check('admin: publicar v1.1 la deja activa', a.ok && a.result.active?.length === 1 && a.result.active[0].version === '1.1', a);
r = await call('GET', '/templates/CA-F-14', undefined, { claims });
check('la activa ahora es la 1.1', r.status === 200 && r.body.template?.version === '1.1', r.body.template?.version);
r = await call('GET', '/templates/CA-F-14?version=1.0', undefined, { claims });
check('la 1.0 sigue disponible pidiéndola', r.status === 200 && r.body.sha256 === sha10, r.body);
r = await call('GET', '/templates/..%2Fx', undefined, { claims });
check('código inválido -> 400 o 404', r.status === 400 || r.status === 404, r.body);

// Un consentimiento firmado con una plantilla publicada queda vinculado a ella.
const tplLog = { ...auditPayload(), consent_id: 'CONS-TPL-1', log_id: crypto.randomUUID(),
  template: { code: 'CA-F-14', version: '1.0', title: CA_F_14.title, exam_type: 'TOMA_DE_MUESTRAS' } };
r = await call('POST', '/consents', consentBody(tplLog), { claims });
const tplEvent = await evidenceStub.getEvent('CONS-TPL-1', 1, 'CONSENT_SIGNED');
check('consentimiento con plantilla: template_ref verificado con el sha256 publicado',
  r.status === 201 && tplEvent?.event?.payload?.template_ref?.verified === true && tplEvent.event.payload.template_ref.sha256 === sha10,
  tplEvent?.event?.payload?.template_ref);
const ghostLog = { ...auditPayload(), consent_id: 'CONS-TPL-2', log_id: crypto.randomUUID(), template: { code: 'NO-EXISTE', version: '9' } };
r = await call('POST', '/consents', consentBody(ghostLog), { claims });
const ghost = await evidenceStub.getEvent('CONS-TPL-2', 1, 'CONSENT_SIGNED');
check('plantilla no publicada: se acepta igual y queda marcada como no verificada',
  r.status === 201 && ghost?.event?.payload?.template_ref?.verified === false && ghost.event.payload.template_ref.reason === 'no_publicada',
  ghost?.event?.payload?.template_ref);

// Paso de aceptar / rechazar
const withDecision = {
  ...CA_F_14, code: 'CA-F-99', version: '1.0',
  decision: {
    prompt: '¿Autoriza?',
    accept: { label: 'Acepto', blocks: [{ type: 'note', text: 'Acepto y firmo.' }] },
    decline: { label: 'No acepto', blocks: [{ type: 'note', text: 'No autorizo y firmo.' }] },
  },
};
a = await admin('publishTemplate', { template: withDecision, activate: false });
check('plantilla con decision: se publica', a.ok, a);
r = await call('GET', '/templates/CA-F-99?version=1.0', undefined, { claims });
check('plantilla con decision: se sirve con accept y decline', r.status === 200 && r.body.template?.decision?.decline?.label === 'No acepto', r.body.template?.decision);
a = await admin('publishTemplate', { template: { ...withDecision, version: '1.1', decision: { ...withDecision.decision, decline: { label: 'No', blocks: [] } } } });
check('decision sin texto de rechazo -> 400', !a.ok && a.status === 400, a);
a = await admin('publishTemplate', { template: { ...CA_F_14, version: '1.9', effectiveDate: 'PENDIENTE' } });
check('effectiveDate que no es fecha -> 400', !a.ok && a.status === 400, a);

// Volver atrás: republicar el archivo de la 1.0 la reactiva (no crea nada nuevo).
a = await admin('publishTemplate', { template: CA_F_14 });
check('rollback: republicar la 1.0 la vuelve a activar', a.ok && a.result.created === false && a.result.active?.[0]?.version === '1.0', a);

a = await admin('retireTemplate', { code: 'CA-F-14' });
check('admin: retirar CA-F-14', a.ok && a.result.active?.length === 0, a);
r = await call('GET', '/templates/CA-F-14', undefined, { claims });
check('retirado: sin versión activa -> 404', r.status === 404, r.body);
const catalogKeys = [...evidenceStub.__store.keys()].filter((k) => k.startsWith('templates/_catalog/'));
check('cada cambio dejó su foto del catálogo (4)', catalogKeys.length === 4, catalogKeys);

// --- 9. rechazo firmado ------------------------------------------------------------------
const declinedLog = { ...auditPayload(), event_type: 'CONSENT_DECLINED', consent_id: 'CONS-RECHAZO-1', log_id: crypto.randomUUID() };
r = await call('POST', '/consents', consentBody(declinedLog), { claims });
check('rechazo: POST /consents acepta CONSENT_DECLINED con su PDF', r.status === 201, r.body);
const declined = await evidenceStub.getEvent('CONS-RECHAZO-1', 1, 'CONSENT_DECLINED');
check('rechazo: queda como 0001-CONSENT_DECLINED + 0002-PDF_VERIFIED',
  declined?.event?.event_type === 'CONSENT_DECLINED' && Boolean(await evidenceStub.getEvent('CONS-RECHAZO-1', 2, 'PDF_VERIFIED')), declined?.event?.event_type);
r = await call('GET', '/consents/CONS-RECHAZO-1/pdf-download-url', undefined, { claims: auditor });
check('rechazo: su PDF se puede descargar', r.status === 200 && Boolean(r.body.url), r.body);
r = await call('POST', '/consents', consentBody({ ...auditPayload(), event_type: 'CONSENT_VIEWED', consent_id: 'CONS-VISTO', log_id: crypto.randomUUID() }), { claims });
check('POST /consents sigue rechazando tipos sin firma (CONSENT_VIEWED) -> 400', r.status === 400, r.body);

// --- 10. varios --------------------------------------------------------------
const noRoute = await call('POST', '/no/existe', {});
check('ruta inexistente -> 404 con message', noRoute.status === 404 && Boolean(noRoute.body.message));

const badJson = await api(
  { ...event('POST', '/auth/login'), body: '{ esto no es json' },
  { callbackWaitsForEmptyEventLoop: true },
);
check('JSON inválido -> 400 con message', badJson.statusCode === 400 && Boolean(JSON.parse(badJson.body).message));

console.log(failures === 0 ? '\nTodo correcto.' : `\n${failures} comprobación(es) fallida(s).`);
process.exit(failures === 0 ? 0 : 1);

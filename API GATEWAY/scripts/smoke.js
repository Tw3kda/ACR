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

function event(method, path, body, { claims = null, headers = {} } = {}) {
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
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

// --- 7. varios --------------------------------------------------------------
const noRoute = await call('POST', '/no/existe', {});
check('ruta inexistente -> 404 con message', noRoute.status === 404 && Boolean(noRoute.body.message));

const badJson = await api(
  { ...event('POST', '/auth/login'), body: '{ esto no es json' },
  { callbackWaitsForEmptyEventLoop: true },
);
check('JSON inválido -> 400 con message', badJson.statusCode === 400 && Boolean(JSON.parse(badJson.body).message));

console.log(failures === 0 ? '\nTodo correcto.' : `\n${failures} comprobación(es) fallida(s).`);
process.exit(failures === 0 ? 0 : 1);

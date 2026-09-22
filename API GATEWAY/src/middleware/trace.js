import { traceEnabled, traceRequest, traceResponse } from '../lib/trace.js';

/**
 * Traza de lo recibido y lo enviado, en dos piezas porque cada una tiene que ir
 * en un punto distinto de la cadena.
 *
 * `traceOutgoing` va **antes** de `express.json()`: engancha `res.json`/`res.send`
 * para poder imprimir también las respuestas de las peticiones que ni siquiera
 * llegan a parsearse (un JSON mal formado, un cuerpo demasiado grande). Se
 * engancha al método y no al evento `finish` porque para entonces el cuerpo ya
 * es una cadena de bytes.
 *
 * `traceIncoming` va **después**, cuando `req.body` ya existe.
 */
export function traceOutgoing(req, res, next) {
  if (!traceEnabled) return next();

  const startedAt = Date.now();
  let printed = false;

  const print = (body) => {
    if (printed) return;
    printed = true;
    traceResponse({
      requestId: req.ctx?.requestId ?? '?',
      method: req.method,
      path: req.originalUrl ?? req.path,
      status: res.statusCode,
      body,
      durationMs: Date.now() - startedAt,
    });
  };

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    print(body);
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    print(body);
    return originalSend(body);
  };

  // Respuestas sin cuerpo: el 204 del preflight de CORS, por ejemplo.
  res.on('finish', () => print(undefined));

  return next();
}

export function traceIncoming(req, res, next) {
  if (!traceEnabled) return next();

  traceRequest({
    requestId: req.ctx?.requestId ?? '?',
    method: req.method,
    path: req.originalUrl ?? req.path,
    sourceIp: req.ctx?.sourceIp,
    headers: req.headers,
    body: req.body,
  });

  return next();
}

import crypto from 'node:crypto';

import config from '../config/env.js';
import logger from '../lib/logger.js';

/**
 * Normaliza lo que aporta API Gateway (payload 2.0) y lo deja en `req.ctx`.
 * Cuando el proceso corre en local, sin evento Lambda, los mismos campos se
 * rellenan desde la petición HTTP para que el resto del código no distinga.
 */
export function requestContext(req, res, next) {
  const event = req.apiGateway?.event;
  const gw = req.requestContext ?? event?.requestContext ?? null;

  const requestId =
    gw?.requestId ?? req.get('x-request-id') ?? req.get('x-amzn-trace-id') ?? crypto.randomUUID();

  // La IP la pone el gateway, no la app: un dispositivo solo ve su IP de LAN y
  // por eso la envía en null.
  const sourceIp = gw?.http?.sourceIp ?? gw?.identity?.sourceIp ?? req.ip ?? null;

  // El reloj del gateway, no el de la tablet.
  const timeEpochMs = Number.isFinite(gw?.timeEpoch) ? gw.timeEpoch : Date.now();

  req.ctx = {
    requestId,
    sourceIp,
    timeEpochMs,
    receivedAtIso: new Date(timeEpochMs).toISOString(),
    // Las pone el JWT authorizer del gateway; puede no existir en rutas públicas.
    gatewayClaims: gw?.authorizer?.jwt?.claims ?? null,
    stage: gw?.stage ?? null,
    isLambda: Boolean(event),
    claims: null, // lo rellena requireAuth
  };

  req.log = logger.child({
    request_id: requestId,
    method: req.method,
    path: req.path,
  });

  res.setHeader('x-request-id', requestId);

  if (!config.isProduction) req.log.debug('petición recibida');

  next();
}

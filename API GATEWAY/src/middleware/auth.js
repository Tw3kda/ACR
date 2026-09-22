import config from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { bearerFrom, decodeJwtPayload, isExpired } from '../lib/jwt.js';

const TOKEN_INVALIDO = 'La sesión expiró, vuelva a iniciar sesión';

/**
 * Autorización de las rutas protegidas.
 *
 * En producción quien valida firma, emisor, audiencia y expiración es el JWT
 * authorizer de API Gateway; aquí solo se leen las claims que ya vienen
 * verificadas. La comprobación *falla cerrada*: si no hay claims —porque alguien
 * dejó una ruta sin authorizer, o porque el Lambda quedó expuesto por una
 * Function URL— la petición no pasa.
 *
 * AUTH_CLAIMS_SOURCE=local decodifica el Bearer sin verificar la firma. Es para
 * desarrollo contra el Cognito simulado y está bloqueado en producción.
 */
export function requireAuth(req, res, next) {
  const fromGateway = req.ctx?.gatewayClaims;

  if (fromGateway && typeof fromGateway === 'object') {
    req.ctx.claims = fromGateway;
    req.ctx.operatorId = fromGateway.sub ?? null;
    if (!req.ctx.operatorId) {
      return next(unauthorized(TOKEN_INVALIDO, { details: { reason: 'claims sin sub' } }));
    }
    return next();
  }

  const localAllowed = config.auth.claimsSource === 'local' || config.auth.allowLocalClaims;
  if (!localAllowed || config.isProduction) {
    return next(
      unauthorized(TOKEN_INVALIDO, {
        details: { reason: 'sin claims del authorizer; revise el JWT authorizer de la ruta' },
      }),
    );
  }

  const token = bearerFrom(req.get('authorization'));
  if (!token) return next(unauthorized(TOKEN_INVALIDO, { details: { reason: 'sin Bearer' } }));

  const payload = decodeJwtPayload(token);
  if (!payload?.sub) {
    return next(unauthorized(TOKEN_INVALIDO, { details: { reason: 'token ilegible' } }));
  }
  // Token vencido -> 401 y nunca 403: la app renueva y reintenta una sola vez.
  if (isExpired(payload)) {
    return next(unauthorized(TOKEN_INVALIDO, { details: { reason: 'exp vencido' } }));
  }

  req.ctx.claims = payload;
  req.ctx.operatorId = payload.sub;
  req.log?.debug('claims tomadas del Bearer sin verificar firma (modo local)');
  return next();
}

/**
 * Barrera opcional de x-api-key. La llave real la aplica el plan de uso de API
 * Gateway; esto solo sirve si el Lambda es alcanzable por otra vía.
 *
 * Importante: una API key embebida en una app móvil **no es un secreto** —
 * cualquiera la extrae del bundle. Es un control de cuota, no de autenticación.
 */
export function requireApiKey(req, res, next) {
  if (!config.http.apiKeyEnforced || !config.http.apiKey) return next();
  const provided = req.get('x-api-key');
  if (provided !== config.http.apiKey) {
    return next(unauthorized('Solicitud no autorizada', { details: { reason: 'x-api-key' } }));
  }
  return next();
}

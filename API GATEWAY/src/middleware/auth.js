import config from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
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
 * El JWT authorizer de un HTTP API entrega las claims de tipo lista como
 * cadena: `cognito:groups` llega como "[auditores]" (o "[a b]" con varios), no
 * como arreglo. En modo local (Bearer decodificado) sí es un arreglo.
 */
export function groupsFrom(claims) {
  const raw = claims?.['cognito:groups'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * Exige pertenencia a un grupo de Cognito. Va SIEMPRE después de requireAuth.
 * Responde 403 y no 401: el token es válido, lo que faltan son permisos, y un
 * 401 haría que el cliente renovase la sesión y reintentase inútilmente.
 */
export const requireGroup = (group) => (req, res, next) => {
  const groups = groupsFrom(req.ctx?.claims);
  req.ctx.groups = groups;
  if (!group || groups.includes(group)) return next();
  return next(
    forbidden('No tiene permiso para consultar consentimientos', { details: { required_group: group } }),
  );
};

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

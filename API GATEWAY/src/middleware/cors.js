import config from '../config/env.js';

/**
 * CORS solo hace falta para `expo start --web` durante el desarrollo. En
 * Android/iOS no aplica, lo que vuelve el síntoma muy confuso: falla en el
 * navegador y funciona en la tablet.
 *
 * En producción esto debería configurarse en el propio API Gateway; se deja aquí
 * para que el mismo código sirva en local sin un proxy delante.
 */
export function cors(req, res, next) {
  if (!config.cors.enabled) return next();

  const origin = req.get('origin');
  const allowed = config.cors.origins;
  const isAllowed = origin && (allowed.includes('*') || allowed.includes(origin));

  if (isAllowed) {
    // Nunca `*` junto a Authorization: se refleja el origen concreto.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', config.cors.methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', config.cors.headers.join(', '));
    res.setHeader('Access-Control-Max-Age', String(config.cors.maxAgeSeconds));
  }

  if (req.method === 'OPTIONS') {
    res.status(isAllowed ? 204 : 403).end();
    return undefined;
  }

  return next();
}

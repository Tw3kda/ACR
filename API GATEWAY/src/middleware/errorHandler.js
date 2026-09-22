import config from '../config/env.js';
import { AppError } from '../lib/errors.js';
import logger from '../lib/logger.js';

/**
 * Un único formato de error, porque la app lee `response.data.message` y se lo
 * muestra al usuario tal cual. Nada de stack traces ni nombres de excepción en
 * el cuerpo: eso va al log.
 */
export function notFoundHandler(req, res, next) {
  next(new AppError(404, 'Recurso no encontrado', { code: 'not_found', details: { path: req.path } }));
}

// Express reconoce el manejador de errores por su aridad de cuatro argumentos.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const log = req.log ?? logger;

  // Errores de body-parser: JSON mal formado o cuerpo demasiado grande.
  if (err?.type === 'entity.parse.failed') {
    log.warn('cuerpo JSON inválido', { error: err.message });
    return res.status(400).json({ message: 'El cuerpo de la petición no es un JSON válido' });
  }
  if (err?.type === 'entity.too.large') {
    log.warn('cuerpo demasiado grande', { limit: config.http.jsonBodyLimit });
    return res.status(413).json({ message: 'El contenido enviado excede el tamaño permitido' });
  }

  if (err instanceof AppError) {
    const level = err.status >= 500 ? 'error' : 'warn';
    log[level]('petición rechazada', {
      status: err.status,
      code: err.code,
      details: err.details,
      ...(err.status >= 500 ? { cause: err.cause?.message } : {}),
    });
    // `code` es estable y legible por máquina: la app decide con él si un
    // rechazo es definitivo (pdf_hash_mismatch: bug) o de datos (conflict).
    // `message` sigue siendo lo que se muestra al usuario.
    return res.status(err.status).json({ message: err.message, code: err.code });
  }

  log.error('error no controlado', {
    error: err?.name,
    detail: err?.message,
    stack: config.isProduction ? undefined : err?.stack,
  });
  return res.status(500).json({ message: 'Ocurrió un error inesperado. Intente de nuevo' });
}

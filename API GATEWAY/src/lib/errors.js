/**
 * Un solo tipo de error para todo el API. `message` es lo que la app muestra al
 * usuario tal cual (contrato: `response.data.message`), así que va siempre en
 * español y sin detalles técnicos. Lo técnico viaja en `details`, que solo se
 * escribe en el log.
 */
export class AppError extends Error {
  constructor(status, message, { code = 'error', details, cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

export const badRequest = (message, opts) => new AppError(400, message, { code: 'bad_request', ...opts });
export const unauthorized = (message, opts) => new AppError(401, message, { code: 'unauthorized', ...opts });
export const forbidden = (message, opts) => new AppError(403, message, { code: 'forbidden', ...opts });
export const notFound = (message, opts) => new AppError(404, message, { code: 'not_found', ...opts });
export const conflict = (message, opts) => new AppError(409, message, { code: 'conflict', ...opts });
export const payloadTooLarge = (message, opts) => new AppError(413, message, { code: 'payload_too_large', ...opts });
export const tooManyRequests = (message, opts) => new AppError(429, message, { code: 'too_many_requests', ...opts });
export const serverError = (message, opts) => new AppError(500, message, { code: 'internal_error', ...opts });
export const notImplemented = (message, opts) => new AppError(501, message, { code: 'not_implemented', ...opts });
export const serviceUnavailable = (message, opts) => new AppError(503, message, { code: 'unavailable', ...opts });

export const isAppError = (err) => err instanceof AppError;

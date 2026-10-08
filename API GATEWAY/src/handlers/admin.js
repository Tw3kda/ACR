import { isAppError } from '../lib/errors.js';
import logger from '../lib/logger.js';
import { reindexNames } from '../services/queryService.js';
import { listActiveTemplates, publishTemplate, retireTemplate } from '../services/templateService.js';

/**
 * Operaciones de administración, sin ruta HTTP. Solo se llega aquí invocando la
 * Lambda directamente (`aws lambda invoke`), lo que exige lambda:InvokeFunction
 * en IAM: un evento de API Gateway nunca trae `source: 'acr.admin'` en la raíz.
 *
 * Escribe con el rol de la Lambda, que es el único al que la política del
 * bucket de evidencia deja escribir. `actor` lo pone el script con la identidad
 * de quien lo ejecuta (sts get-caller-identity).
 */
export const isAdminEvent = (event) => event?.source === 'acr.admin' && typeof event.action === 'string';

const ACTIONS = {
  listTemplates: () => listActiveTemplates(),
  publishTemplate: (e) => publishTemplate({ raw: e.template, activate: e.activate !== false, actor: actorOf(e) }),
  retireTemplate: (e) => retireTemplate({ code: String(e.code ?? ''), actor: actorOf(e) }),
  reindexNames: () => reindexNames(),
};

const actorOf = (e) => (typeof e.actor === 'string' && e.actor ? e.actor.slice(0, 256) : 'desconocido');

export async function handleAdmin(event) {
  const action = ACTIONS[event.action];
  if (!action) return { ok: false, status: 400, message: `Acción desconocida: ${event.action}` };
  try {
    const result = await action(event);
    logger.info('acción de administración', { action: event.action, actor: actorOf(event) });
    return { ok: true, result };
  } catch (err) {
    if (isAppError(err)) return { ok: false, status: err.status, message: err.message, code: err.code };
    logger.error('fallo en acción de administración', { action: event.action, error: err?.name, detail: err?.message });
    return { ok: false, status: 500, message: 'Error inesperado' };
  }
}

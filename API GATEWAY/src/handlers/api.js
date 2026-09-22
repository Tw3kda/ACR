import serverlessExpress from 'serverless-http';

import config, { assertDeployable } from '../config/env.js';
import { createApp } from '../app.js';
import logger from '../lib/logger.js';

// Todo lo caro ocurre en el arranque en frío y se reutiliza entre invocaciones:
// la app de Express, los clientes del SDK y la resolución de credenciales.
assertDeployable();

const app = createApp();
const handle = serverlessExpress(app, {
  // El cuerpo llega como string en event.body y la respuesta debe salir igual;
  // de eso se encarga el adaptador. Devolver un objeto suelto produce un 502
  // sin traza útil.
  request(request, event) {
    request.apiGatewayEventVersion = event.version ?? '1.0';
  },
});

/**
 * Si el API se despliega bajo un stage nombrado (`/prod/auth/login`), el path
 * llega con el prefijo y ninguna ruta casa. Con el stage `$default` no hace
 * falta tocar nada y API_STAGE_PREFIX queda vacío.
 */
function stripStagePrefix(event) {
  const prefix = config.http.stagePrefix;
  if (!prefix || typeof event?.rawPath !== 'string') return event;
  if (!event.rawPath.startsWith(prefix)) return event;

  const rawPath = event.rawPath.slice(prefix.length) || '/';
  return {
    ...event,
    rawPath,
    path: rawPath,
    requestContext: {
      ...event.requestContext,
      http: { ...event.requestContext?.http, path: rawPath },
    },
  };
}

export const handler = async (event, context) => {
  // Sin esto, Lambda espera a que se vacíe el event loop y añade latencia (y a
  // veces cuelga) en cuanto un cliente del SDK deja un socket abierto.
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    return await handle(stripStagePrefix(event), context);
  } catch (err) {
    // Última red: cualquier cosa que escape del adaptador saldría como 502 sin
    // cuerpo, y la app necesita `message` para mostrar algo al usuario.
    logger.error('fallo en el adaptador Lambda', { error: err?.name, detail: err?.message });
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Ocurrió un error inesperado. Intente de nuevo' }),
    };
  }
};

export default handler;

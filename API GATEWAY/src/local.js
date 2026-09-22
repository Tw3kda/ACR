/**
 * Servidor HTTP normal para desarrollo. El mismo `app` que se monta dentro de
 * Lambda, sin adaptador: sirve para apuntar la app de Expo a
 * `EXPO_PUBLIC_API_URL=http://localhost:3000` y probar el flujo completo.
 */
import config, { stubbedDrivers } from './config/env.js';
import { createApp } from './app.js';
import logger from './lib/logger.js';

const app = createApp();

const server = app.listen(config.http.port, () => {
  logger.info('API escuchando', {
    port: config.http.port,
    env: config.nodeEnv,
    stubbed: stubbedDrivers(),
    rutas: config.routes,
  });
});

const shutdown = (signal) => {
  logger.info('cerrando', { signal });
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

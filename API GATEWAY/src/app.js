import express from 'express';

import config, { stubbedDrivers } from './config/env.js';
import { cors } from './middleware/cors.js';
import { requestContext } from './middleware/requestContext.js';
import { requireApiKey } from './middleware/auth.js';
import { traceIncoming, traceOutgoing } from './middleware/trace.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.routes.js';
import auditRoutes from './routes/audit.routes.js';
import consentsRoutes from './routes/consents.routes.js';
import templatesRoutes from './routes/templates.routes.js';
import { s3 } from './aws/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // La IP buena es la del requestContext del gateway; esto solo importa cuando
  // el proceso corre como servidor normal detrás de un proxy.
  app.set('trust proxy', config.http.trustProxy);

  app.use(requestContext);
  app.use(cors);

  // Antes del parseo, para que también se vea la respuesta de lo que no llega a
  // parsearse (JSON mal formado, cuerpo demasiado grande).
  app.use(traceOutgoing);

  // API Gateway corta en 10 MB y Lambda en 6 MB de payload síncrono: el límite
  // real está antes que este, pero conviene rechazar aquí con un mensaje claro.
  app.use(express.json({ limit: config.http.jsonBodyLimit, strict: true }));

  // Ya con req.body disponible.
  app.use(traceIncoming);
  app.use(requireApiKey);

  app.get(config.routes.health, (req, res) => {
    // La ruta es pública en el gateway: en producción responde lo mínimo para
    // un health check y nada sobre qué hay detrás.
    if (!config.health.detailed) {
      res.json({ status: 'ok' });
      return;
    }

    res.json({
      status: 'ok',
      service: config.serviceName,
      env: config.nodeEnv,
      drivers: {
        cognito: config.cognito.driver,
        evidence: config.evidence.driver,
        s3: config.s3.driver,
      },
      stubbed: stubbedDrivers(),
      time: new Date().toISOString(),
    });
  });

  // Con S3 simulado, la "URL firmada" del PDF apunta aquí (ver s3.stub.js).
  // No existe con el adaptador real ni en producción.
  if (s3.driver === 'stub' && !config.isProduction) {
    app.get('/__stub/s3/object', async (req, res) => {
      const { key, disposition, expires } = req.query;
      if (!key || Number(expires) < Date.now()) return res.status(403).send('Request has expired');
      const bytes = await s3.getPdfBytes(String(key));
      if (!bytes) return res.status(404).send('NoSuchKey');
      res.setHeader('Content-Type', 'application/pdf');
      if (disposition) res.setHeader('Content-Disposition', String(disposition));
      return res.send(bytes);
    });
  }

  app.use(authRoutes);
  app.use(auditRoutes);
  app.use(consentsRoutes);
  app.use(templatesRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;

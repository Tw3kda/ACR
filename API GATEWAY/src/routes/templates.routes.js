import { Router } from 'express';

import config from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { getTemplate, listActiveTemplates } from '../services/templateService.js';

const router = Router();

// Las tablets descargan aquí los formularios. Basta con estar autenticado: el
// profesional de la tablet no es auditor. Publicar NO tiene ruta HTTP: se hace
// invocando la Lambda con IAM (scripts/publish-template.mjs).

router.get(config.routes.templates, requireAuth, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json(await listActiveTemplates());
  } catch (err) {
    return next(err);
  }
});

router.get(config.routes.template, requireAuth, async (req, res, next) => {
  try {
    const version = typeof req.query.version === 'string' ? req.query.version : undefined;
    const result = await getTemplate(req.params.code, version);
    // Una versión concreta no cambia nunca; la "activa" sí.
    res.setHeader('Cache-Control', version ? 'private, max-age=86400, immutable' : 'private, max-age=60');
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;

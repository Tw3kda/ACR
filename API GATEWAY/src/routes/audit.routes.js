import { Router } from 'express';

import config from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { storeAuditLog } from '../services/auditService.js';

const router = Router();

router.post(config.routes.auditLogs, requireAuth, async (req, res, next) => {
  try {
    const result = await storeAuditLog(req.body ?? {}, {
      sourceIp: req.ctx.sourceIp,
      operatorId: req.ctx.operatorId,
      receivedAtIso: req.ctx.receivedAtIso,
      requestId: req.ctx.requestId,
    });

    // Un reenvío del outbox no es un fallo: el log ya estaba guardado. Se
    // responde 200 (éxito idempotente) y no 409, porque la app trata cualquier
    // 4xx como respuesta definitiva y mostraría un error al usuario.
    if (!result.created) {
      return res.status(200).json({ log_id: result.logId, duplicate: true });
    }

    return res.status(201).json({ log_id: result.logId });
  } catch (err) {
    return next(err);
  }
});

export default router;

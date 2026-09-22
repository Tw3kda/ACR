import { Router } from 'express';

import config from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { submitConsent } from '../services/consentService.js';

const router = Router();

router.post(config.routes.consents, requireAuth, async (req, res, next) => {
  try {
    const result = await submitConsent(req.body ?? {}, {
      sourceIp: req.ctx.sourceIp,
      operatorId: req.ctx.operatorId,
      receivedAtIso: req.ctx.receivedAtIso,
      requestId: req.ctx.requestId,
    });

    const body = {
      consent_id: result.consentId,
      log_id: result.logId,
      pdf: { bucket: result.pdf.bucket, key: result.pdf.key, sha256: result.pdf.sha256, size_bytes: result.pdf.sizeBytes },
      events: { signed_sha256: result.events.signed, verified_sha256: result.events.verified },
    };

    // Un reenvío del outbox no es un fallo: todo ya estaba guardado. 200 y no
    // 409, porque la app trata cualquier 4xx como respuesta definitiva.
    if (result.duplicate) {
      return res.status(200).json({ ...body, duplicate: true });
    }
    return res.status(201).json(body);
  } catch (err) {
    return next(err);
  }
});

export default router;

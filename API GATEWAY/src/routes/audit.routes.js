import { Router } from 'express';

import config from '../config/env.js';
import { requireAuth, requireGroup } from '../middleware/auth.js';
import { storeAuditLog } from '../services/auditService.js';
import { listPatientsBetween, searchByPatient, suggestPatients } from '../services/queryService.js';

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

// Web de consulta. POST a propósito: la cédula viaja en el cuerpo y no en la
// URL, así no queda en los access logs del gateway ni en el historial.
router.post(config.routes.auditSearch, requireAuth, requireGroup(config.auth.readerGroup), async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const result = await searchByPatient({
      patientId: body.patient_id,
      kind: body.kind,
      ctx: { ...req.ctx, userAgent: req.get('user-agent') ?? null },
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

const reader = [requireAuth, requireGroup(config.auth.readerGroup)];
const ctxOf = (req) => ({ ...req.ctx, userAgent: req.get('user-agent') ?? null });

// Pacientes atendidos en un rango (el "hoy" del navegador).
router.post(config.routes.patientsToday, ...reader, async (req, res, next) => {
  try {
    const { from, to } = req.body ?? {};
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await listPatientsBetween({ from, to, ctx: ctxOf(req) }));
  } catch (err) {
    return next(err);
  }
});

// Búsqueda mientras se escribe (coincidencia parcial de la cédula).
router.post(config.routes.patientsSuggest, ...reader, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await suggestPatients({ q: req.body?.q, ctx: ctxOf(req) }));
  } catch (err) {
    return next(err);
  }
});

export default router;

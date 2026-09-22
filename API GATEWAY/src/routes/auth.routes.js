import { Router } from 'express';

import config from '../config/env.js';
import * as authService from '../services/authService.js';

const router = Router();

// Estas tres rutas van SIN autorizador: son las que crean la sesión.
// La protección frente a fuerza bruta corresponde al gateway (throttling) y a
// WAF; ver "Hallazgo 4" en la documentación.

router.post(config.routes.login, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const session = await authService.login({ email, password });
    req.log.info('login correcto', { user_id: session.user?.id });
    res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

router.post(config.routes.register, async (req, res, next) => {
  try {
    const { email, password, name, invite_code: inviteCode } = req.body ?? {};
    const session = await authService.register({ email, password, name, inviteCode });
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

router.post(config.routes.refresh, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    // La app envía `refresh_token`; se acepta también `refreshToken`.
    const token = body.refresh_token ?? body.refreshToken;
    const session = await authService.refresh({
      refreshToken: token,
      username: body.username ?? body.email,
    });
    res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

export default router;

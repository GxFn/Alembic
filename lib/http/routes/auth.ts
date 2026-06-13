/**
 * Auth routes are retained only as explicit compatibility tombstones.
 *
 * Alembic mainline has no privileged user model. Operation-specific entrypoints
 * own their own input and safety checks.
 */

import express, { type Request, type Response } from 'express';
import { AuthLoginBody } from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

function retiredAuthResponse(_req: Request, res: Response): void {
  res.status(410).json({
    success: false,
    error: {
      code: 'AUTH_MODEL_RETIRED',
      message: 'Alembic mainline does not use login or privileged user roles.',
    },
  });
}

router.post('/login', validate(AuthLoginBody), retiredAuthResponse);
router.get('/me', retiredAuthResponse);

export default router;

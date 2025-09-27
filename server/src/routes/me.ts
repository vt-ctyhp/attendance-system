import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../auth';

export const meRouter = Router();

meRouter.get('/', authenticate, (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt
    }
  });
});

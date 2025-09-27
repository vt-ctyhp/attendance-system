import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { generateToken, verifyPassword } from '../auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { parseWithSchema } from '../utils/validation';
import { HttpError } from '../errors';
import { createRateLimiter } from '../middleware/rateLimit';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const authRouter = Router();

const loginRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 8,
  message: 'Too many login attempts'
});

authRouter.post(
  '/login',
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parseWithSchema(loginSchema, req.body, 'Invalid credentials');
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw HttpError.unauthorized('Invalid credentials');
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw HttpError.unauthorized('Invalid credentials');
    }
    const token = generateToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt
      }
    });
  })
);

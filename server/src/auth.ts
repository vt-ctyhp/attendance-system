import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import type { User } from '@prisma/client';
import { env } from './env';
import { prisma } from './prisma';
import { USER_ROLES, type UserRole } from './types';
import { HttpError } from './errors';
import { EMPLOYEE_SESSION_SCOPE } from './services/tokenService';

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

type TokenPayload = jwt.JwtPayload & {
  sub: number;
  role: UserRole;
  scope?: string;
  typ?: string;
  jti?: string;
};

export interface AuthenticatedRequest extends Request {
  user?: User;
  tokenScope?: string;
  tokenType?: string;
  tokenId?: string;
}

export const hashPassword = async (password: string) => bcrypt.hash(password, 12);

export const verifyPassword = async (password: string, hash: string) => bcrypt.compare(password, hash);

export const generateToken = (user: User) =>
  jwt.sign({ sub: user.id, role: user.role as UserRole, scope: 'full', typ: 'access' }, env.JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS
  }) as string;

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return next(HttpError.unauthorized('Missing token'));
    }
    const token = header.slice(7);
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (!decoded || typeof decoded !== 'object' || !('sub' in decoded) || !('role' in decoded)) {
      return next(HttpError.unauthorized());
    }
    const payload = decoded as TokenPayload;
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return next(HttpError.unauthorized('User not found'));
    }
    if (!user.active) {
      return next(HttpError.unauthorized('User not active'));
    }
    req.user = user;
    req.tokenScope = payload.scope ?? 'full';
    req.tokenType = payload.typ ?? 'access';
    req.tokenId = payload.jti;
    return next();
  } catch (err) {
    return next(HttpError.unauthorized());
  }
};

export const requireRole = (roles: UserRole[]) => (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const { user } = req;
  if (!user) {
    return next(HttpError.unauthorized());
  }
  const role = USER_ROLES.find((value) => value === user.role) ?? user.role;
  if (!roles.includes(role as UserRole)) {
    return next(HttpError.forbidden());
  }
  if (req.tokenScope === EMPLOYEE_SESSION_SCOPE && roles.some((allowed) => allowed !== 'employee')) {
    return next(HttpError.forbidden());
  }
  return next();
};

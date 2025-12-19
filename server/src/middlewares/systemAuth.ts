import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { getCookieValue, getSessionByToken } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/cookies.js';

function getProvidedApiKey(req: Request): string {
  return (
    req.header('x-api-key') ||
    req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    ''
  );
}

export function systemAuth(prisma: PrismaClient, options?: { allowApiKey?: boolean; allowAnonymous?: boolean }) {
  const allowApiKey = options?.allowApiKey !== false;
  const allowAnonymous = options?.allowAnonymous === true;

  return async (req: Request, res: Response, next: NextFunction) => {
    const providedKey = getProvidedApiKey(req);
    const sid = getCookieValue(req.header('cookie'), SESSION_COOKIE_NAME);

    if (providedKey && sid) {
      res.status(400).json({ success: false, error: 'Ambiguous credentials' });
      return;
    }

    if (providedKey) {
      if (!allowApiKey) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      if (!config.apiKey || providedKey !== config.apiKey) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      req.systemAuth = { kind: 'apiKey' };
      next();
      return;
    }

    if (sid) {
      try {
        const session = await getSessionByToken(prisma, { token: sid });
        if (!session) {
          res.status(401).json({ success: false, error: 'Unauthorized' });
          return;
        }

        req.systemAuth = {
          kind: 'session',
          sessionId: session.id,
          token: sid,
          csrfToken: session.csrfToken,
          user: {
            id: session.user.id,
            username: session.user.username,
            role: session.user.role,
          },
        };

        next();
        return;
      } catch (err) {
        res.status(500).json({ success: false, error: String(err) });
        return;
      }
    }

    if (allowAnonymous) {
      next();
      return;
    }

    res.status(401).json({ success: false, error: 'Unauthorized' });
  };
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.systemAuth || req.systemAuth.kind !== 'session') {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.systemAuth || req.systemAuth.kind !== 'session') {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  if (req.systemAuth.user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!req.systemAuth || req.systemAuth.kind !== 'session') {
    next();
    return;
  }

  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const headerToken = req.header('x-csrf-token') || '';
  if (!headerToken || headerToken !== req.systemAuth.csrfToken) {
    res.status(403).json({ success: false, error: 'CSRF validation failed' });
    return;
  }

  next();
}

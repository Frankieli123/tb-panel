import { Router, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteSessionByToken } from '../auth/session.js';
import { clearSessionCookie, setSessionCookie } from '../auth/cookies.js';
import { generateInviteCode } from '../auth/invite.js';
import { requireAdmin } from '../middlewares/systemAuth.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});

const registerSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  inviteCode: z.string().min(1),
});

export default function createAuthRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/me', async (req: Request, res: Response) => {
    if (req.systemAuth?.kind !== 'session') {
      res.json({ success: true, data: null });
      return;
    }

    res.json({
      success: true,
      data: {
        user: {
          id: req.systemAuth.user.id,
          username: req.systemAuth.user.username,
          role: req.systemAuth.user.role,
        },
        csrfToken: req.systemAuth.csrfToken,
      },
    });
  });

  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { username, password, rememberMe } = loginSchema.parse(req.body);

      const user = await (prisma as any).systemUser.findUnique({
        where: { username: username.trim() },
      });

      if (!user || !user.isActive || !verifyPassword(password, String(user.passwordHash))) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const ttlMs = rememberMe ? (config as any).auth.rememberMeTtlMs : (config as any).auth.sessionTtlMs;
      const session = await createSession(prisma, { userId: user.id, ttlMs });
      setSessionCookie(res, session.token, session.expiresAt);

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors });
        return;
      }
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { username, password, inviteCode } = registerSchema.parse(req.body);
      const normalizedUsername = username.trim();

      const existingCount = await (prisma as any).systemUser.count();
      const isBootstrap = existingCount === 0;

      const ttlMs = (config as any).auth.rememberMeTtlMs;

      if (isBootstrap) {
        if (!(config as any).auth.bootstrapInviteCode) {
          res.status(400).json({ success: false, error: 'Bootstrap invite code not configured' });
          return;
        }
        if (inviteCode.trim() !== (config as any).auth.bootstrapInviteCode) {
          res.status(400).json({ success: false, error: 'Invalid invite code' });
          return;
        }

        const passwordHash = hashPassword(password);

        const user = await (prisma as any).systemUser.create({
          data: {
            username: normalizedUsername,
            passwordHash,
            role: 'admin',
            isActive: true,
          },
        });

        const session = await createSession(prisma, { userId: user.id, ttlMs });
        setSessionCookie(res, session.token, session.expiresAt);

        res.json({ success: true });
        return;
      }

      const passwordHash = hashPassword(password);

      const createdUser = await (prisma as any).$transaction(async (tx: any) => {
        const invite = await tx.inviteCode.findFirst({
          where: {
            code: inviteCode.trim(),
            usedAt: null,
            isActive: true,
            deletedAt: null,
          },
        });
        if (!invite) {
          throw new Error('Invalid invite code');
        }

        const u = await tx.systemUser.create({
          data: {
            username: normalizedUsername,
            passwordHash,
            role: 'operator',
            isActive: true,
          },
        });

        await tx.inviteCode.update({
          where: { id: invite.id },
          data: { usedAt: new Date(), usedById: u.id },
        });

        return u;
      });

      const session = await createSession(prisma, { userId: createdUser.id, ttlMs });
      setSessionCookie(res, session.token, session.expiresAt);

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors });
        return;
      }
      if (String(error).includes('Invalid invite code')) {
        res.status(400).json({ success: false, error: 'Invalid invite code' });
        return;
      }
      if (String(error).includes('Unique constraint')) {
        res.status(400).json({ success: false, error: 'Username already exists' });
        return;
      }
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.post('/logout', async (req: Request, res: Response) => {
    try {
      if (req.systemAuth?.kind === 'session') {
        await deleteSessionByToken(prisma, { token: req.systemAuth.token });
      }
    } catch {
      // ignore
    } finally {
      clearSessionCookie(res);
      res.json({ success: true });
    }
  });

  router.post('/invite-codes', requireAdmin, async (req: Request, res: Response) => {
    try {
      const code = generateInviteCode();
      await (prisma as any).inviteCode.create({
        data: {
          code,
          isActive: true,
          createdById: req.systemAuth?.kind === 'session' ? req.systemAuth.user.id : null,
        },
      });
      res.json({ success: true, data: { code } });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.get('/invite-codes', requireAdmin, async (req: Request, res: Response) => {
    try {
      const codes = await (prisma as any).inviteCode.findMany({
        include: {
          createdBy: { select: { id: true, username: true, role: true } },
          usedBy: { select: { id: true, username: true, role: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: codes });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.post('/invite-codes/:id/disable', requireAdmin, async (req: Request, res: Response) => {
    try {
      await (prisma as any).inviteCode.update({
        where: { id: req.params.id },
        data: {
          isActive: false,
          disabledAt: new Date(),
        },
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  router.delete('/invite-codes/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      await (prisma as any).inviteCode.update({
        where: { id: req.params.id },
        data: {
          isActive: false,
          deletedAt: new Date(),
        },
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  return router;
}

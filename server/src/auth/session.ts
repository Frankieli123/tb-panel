import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';

function base64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return base64Url(randomBytes(32));
}

export function generateCsrfToken(): string {
  return base64Url(randomBytes(24));
}

export async function createSession(
  prisma: PrismaClient,
  input: { userId: string; ttlMs: number }
): Promise<{ token: string; csrfToken: string; expiresAt: Date; tokenHash: string }>
{
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const csrfToken = generateCsrfToken();
  const expiresAt = new Date(Date.now() + input.ttlMs);

  await (prisma as any).systemSession.create({
    data: {
      userId: input.userId,
      tokenHash,
      csrfToken,
      expiresAt,
    },
  });

  return { token, csrfToken, expiresAt, tokenHash };
}

export type SystemUserRole = 'admin' | 'operator';

export type SessionWithUser = {
  id: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; username: string; role: SystemUserRole; isActive: boolean };
};

export async function getSessionByToken(
  prisma: PrismaClient,
  input: { token: string }
): Promise<SessionWithUser | null>
{
  const tokenHash = hashSessionToken(input.token);
  const session = await (prisma as any).systemSession.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: { id: true, username: true, role: true, isActive: true },
      },
    },
  });

  if (!session) return null;
  if (!session.user?.isActive) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

  await (prisma as any).systemSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });

  return session as SessionWithUser;
}

export async function deleteSessionByToken(prisma: PrismaClient, input: { token: string }): Promise<void> {
  const tokenHash = hashSessionToken(input.token);
  await (prisma as any).systemSession.deleteMany({ where: { tokenHash } });
}

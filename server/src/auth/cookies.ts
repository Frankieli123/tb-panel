import type { Response } from 'express';
import { config } from '../config/index.js';

export const SESSION_COOKIE_NAME = 'tb_panel_sid';

function resolveSameSite(): 'lax' | 'none' {
  const explicit = (config as any).auth?.cookieSameSite as string | undefined;
  if (explicit === 'none') return 'none';
  return 'lax';
}

function resolveSecure(): boolean {
  const explicit = (config as any).auth?.cookieSecure as boolean | undefined;
  if (typeof explicit === 'boolean') return explicit;
  return config.env === 'production';
}

function resolveDomain(): string | undefined {
  const domain = (config as any).auth?.cookieDomain as string | undefined;
  return domain || undefined;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: resolveSameSite(),
    secure: resolveSecure(),
    domain: resolveDomain(),
    expires: expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: resolveSameSite(),
    secure: resolveSecure(),
    domain: resolveDomain(),
    path: '/',
  });
}

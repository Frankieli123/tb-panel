import type { Request } from 'express';
import type { Prisma } from '@prisma/client';

export type RequestScope =
  | { kind: 'all' }
  | { kind: 'user'; userId: string };

export function getRequestScope(req: Request): RequestScope {
  if (req.systemAuth?.kind === 'session' && req.systemAuth.user.role === 'operator') {
    return { kind: 'user', userId: req.systemAuth.user.id };
  }
  return { kind: 'all' };
}

export function getSessionUserId(req: Request): string | null {
  if (req.systemAuth?.kind !== 'session') return null;
  return req.systemAuth.user.id;
}

export function isAdminSession(req: Request): boolean {
  return req.systemAuth?.kind === 'session' && req.systemAuth.user.role === 'admin';
}

export function isOperatorSession(req: Request): boolean {
  return req.systemAuth?.kind === 'session' && req.systemAuth.user.role === 'operator';
}

export function buildVisibleAccountsWhere(req: Request): Prisma.TaobaoAccountWhereInput {
  const scope = getRequestScope(req);
  if (scope.kind === 'user') {
    return { userId: scope.userId };
  }
  return {};
}

export function buildVisibleProductsWhere(req: Request): Prisma.ProductWhereInput {
  const scope = getRequestScope(req);

  if (scope.kind === 'all') {
    return { monitorMode: 'CART' };
  }

  return {
    monitorMode: 'CART',
    ownerAccount: { is: { userId: scope.userId } },
  };
}

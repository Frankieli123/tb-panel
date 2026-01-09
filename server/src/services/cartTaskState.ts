export type CartOpKind = 'ADD';

type CartOpState = {
  kind: CartOpKind;
  startedAt: number;
};

const active = new Map<string, CartOpState>();

export function markCartOpStart(accountId: string, kind: CartOpKind): void {
  const id = String(accountId || '').trim();
  if (!id) return;
  active.set(id, { kind, startedAt: Date.now() });
}

export function markCartOpEnd(accountId: string, kind?: CartOpKind): void {
  const id = String(accountId || '').trim();
  if (!id) return;
  const cur = active.get(id);
  if (!cur) return;
  if (!kind || cur.kind === kind) active.delete(id);
}

export function getCartOpState(accountId: string): CartOpState | null {
  const id = String(accountId || '').trim();
  if (!id) return null;
  return active.get(id) ?? null;
}

export function isCartOpActive(accountId: string, kind?: CartOpKind): boolean {
  const state = getCartOpState(accountId);
  if (!state) return false;
  if (!kind) return true;
  return state.kind === kind;
}


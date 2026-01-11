export type CartSkuStats = {
  cartSkuTotal: number | null;
  cartSkuLoaded: number;
  updatedAt: number;
};

const statsByAccountId = new Map<string, CartSkuStats>();

function toNonNegativeIntOrNull(input: unknown): number | null {
  const value = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function toNonNegativeInt(input: unknown, fallback = 0): number {
  const value = toNonNegativeIntOrNull(input);
  return value === null ? fallback : value;
}

export function setCartSkuStats(
  accountId: string,
  input: { cartSkuTotal?: number | null; cartSkuLoaded: number }
): void {
  const id = String(accountId || '').trim();
  if (!id) return;

  const cartSkuLoaded = toNonNegativeInt(input.cartSkuLoaded, 0);
  const cartSkuTotalRaw = input.cartSkuTotal;
  const cartSkuTotal =
    cartSkuTotalRaw === null || cartSkuTotalRaw === undefined ? null : toNonNegativeIntOrNull(cartSkuTotalRaw);

  statsByAccountId.set(id, { cartSkuTotal, cartSkuLoaded, updatedAt: Date.now() });
}

export function getCartSkuStats(accountId: string): CartSkuStats | null {
  const id = String(accountId || '').trim();
  if (!id) return null;
  return statsByAccountId.get(id) ?? null;
}


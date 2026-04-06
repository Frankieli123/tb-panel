export type CartSkuSnapshot = Map<string, Set<string>>;

export function normalizeCartSkuProperties(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  const normalized = raw
    .replace(/[；]/g, ';')
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*/g, ';')
    .trim();

  const pairs: Array<{ label: string; value: string }> = [];
  const pairRe = /([^:;\s]+)\s*:\s*([^;]+?)(?=\s+[^:;\s]+\s*:|;|$)/g;
  for (const match of normalized.matchAll(pairRe)) {
    const label = String(match[1] ?? '').trim();
    const value = String(match[2] ?? '').trim();
    if (!label || !value) continue;
    pairs.push({ label, value });
  }

  if (pairs.length === 0) return normalized;
  pairs.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  return pairs.map((p) => `${p.label}:${p.value}`).join(';');
}

export function isDigits(input: unknown): boolean {
  return /^\d+$/.test(String(input ?? '').trim());
}

export function toCartSkuIdKey(input: unknown): string | null {
  const text = String(input ?? '').trim();
  if (!text || !isDigits(text)) return null;
  return `id:${text}`;
}

export function toCartSkuPropsKey(input: unknown): string | null {
  const normalized = normalizeCartSkuProperties(String(input ?? '').trim());
  if (!normalized) return null;
  return `props:${normalized}`;
}

export function normalizeExistingCartSkuKey(input: unknown): string | null {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (text.startsWith('id:') || text.startsWith('props:')) return text;
  return toCartSkuIdKey(text) ?? toCartSkuPropsKey(text);
}

export function hasAnyCartSkuKey(set: Set<string>, skuId: unknown, skuProperties: unknown): boolean {
  const idKey = toCartSkuIdKey(skuId);
  const propsKey = toCartSkuPropsKey(skuProperties);
  return Boolean((idKey && set.has(idKey)) || (propsKey && set.has(propsKey)));
}

export function cloneCartSkuSnapshot(input?: CartSkuSnapshot | null): CartSkuSnapshot {
  const next: CartSkuSnapshot = new Map();
  if (!input) return next;
  for (const [taobaoId, keys] of input.entries()) {
    const id = String(taobaoId || '').trim();
    if (!id) continue;
    next.set(id, new Set(Array.from(keys ?? []).map((x) => String(x || '').trim()).filter(Boolean)));
  }
  return next;
}

export function ensureCartSkuSnapshotEntry(snapshot: CartSkuSnapshot, taobaoId: string): Set<string> {
  const id = String(taobaoId || '').trim();
  const existing = snapshot.get(id);
  if (existing) return existing;
  const created = new Set<string>();
  snapshot.set(id, created);
  return created;
}

export function addCartSkuKeys(
  snapshot: CartSkuSnapshot,
  taobaoId: string,
  skuId: unknown,
  skuProperties: unknown
): Set<string> {
  const id = String(taobaoId || '').trim();
  if (!isDigits(id)) return ensureCartSkuSnapshotEntry(snapshot, id);
  const entry = ensureCartSkuSnapshotEntry(snapshot, id);
  const idKey = toCartSkuIdKey(skuId);
  const propsKey = toCartSkuPropsKey(skuProperties);
  if (idKey) entry.add(idKey);
  if (propsKey) entry.add(propsKey);
  return entry;
}

export function buildCartSkuSnapshot(
  products: Array<{ taobaoId?: unknown; skuId?: unknown; skuProperties?: unknown }>,
  input?: CartSkuSnapshot | null
): CartSkuSnapshot {
  const snapshot = cloneCartSkuSnapshot(input);
  for (const product of products ?? []) {
    addCartSkuKeys(snapshot, String(product?.taobaoId ?? ''), product?.skuId, product?.skuProperties);
  }
  return snapshot;
}

export function mergeSuccessfulSkuResults(
  snapshot: CartSkuSnapshot,
  taobaoId: string,
  results: Array<{ success?: unknown; skuId?: unknown; skuProperties?: unknown }> | null | undefined
): CartSkuSnapshot {
  const id = String(taobaoId || '').trim();
  if (!isDigits(id)) return snapshot;
  for (const result of results ?? []) {
    if (!result || result.success !== true) continue;
    addCartSkuKeys(snapshot, id, result.skuId, result.skuProperties);
  }
  return snapshot;
}

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { PriceSnapshot, Variant } from '../types';
import { api } from '../services/api';
import PriceChart from './PriceChart';

interface SkuVariantPanelProps {
  productId: string;
  productImageUrl: string | null;
}

type HistoryByVariantKey = Record<string, PriceSnapshot[]>;

type LoadingByVariantKey = Record<string, boolean>;

type ErrorByVariantKey = Record<string, string | null>;

export default function SkuVariantPanel({ productId, productImageUrl }: SkuVariantPanelProps) {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedGroup, setSelectedGroup] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const [historyByKey, setHistoryByKey] = useState<HistoryByVariantKey>({});
  const [historyLoadingByKey, setHistoryLoadingByKey] = useState<LoadingByVariantKey>({});
  const [historyErrorByKey, setHistoryErrorByKey] = useState<ErrorByVariantKey>({});

  const [query, setQuery] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const data = await api.getProductVariantsLatest(productId);
        if (cancelled) return;

        setVariants(data);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || '加载SKU失败');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [productId]);

  const primaryDimension = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    const order = new Map<string, number>();
    let orderCounter = 0;

    for (const v of variants) {
      for (const s of v.selections || []) {
        const label = (s.label || '').trim();
        const value = (s.value || '').trim();
        if (!label || !value) continue;
        if (!counts.has(label)) {
          counts.set(label, new Set());
          order.set(label, orderCounter++);
        }
        counts.get(label)!.add(value);
      }
    }

    let bestLabel = '';
    let bestSize = Number.POSITIVE_INFINITY;
    let bestOrder = Number.POSITIVE_INFINITY;

    for (const [label, set] of counts.entries()) {
      const size = set.size;
      const ord = order.get(label) ?? 0;
      if (size < bestSize || (size === bestSize && ord < bestOrder)) {
        bestLabel = label;
        bestSize = size;
        bestOrder = ord;
      }
    }

    const values = bestLabel ? Array.from(counts.get(bestLabel) ?? []) : [];
    return { label: bestLabel, values };
  }, [variants]);

  const groupLabel = useMemo(() => {
    return primaryDimension.label || variants.find((v) => v.selections && v.selections.length > 0)?.selections?.[0]?.label || '';
  }, [primaryDimension.label, variants]);

  const grouped = useMemo(() => {
    const by: Record<string, Variant[]> = {};

    for (const v of variants) {
      const key =
        (groupLabel ? v.selections?.find((s) => (s.label || '').trim() === groupLabel)?.value : null) ||
        v.selections?.[0]?.value ||
        '默认';
      if (!by[key]) by[key] = [];
      by[key].push(v);
    }

    return by;
  }, [groupLabel, variants]);

  const groups = useMemo(() => {
    const keys = Object.keys(grouped);
    if (!groupLabel) return keys;

    const ordered: string[] = [];
    for (const v of primaryDimension.values) {
      if (keys.includes(v)) ordered.push(v);
    }
    for (const k of keys) {
      if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered;
  }, [groupLabel, grouped, primaryDimension.values]);

  useEffect(() => {
    if (groups.length === 0) return;
    if (!selectedGroup || !groups.includes(selectedGroup)) {
      setSelectedGroup(groups[0]);
    }
  }, [groups, selectedGroup]);

  const currentVariants = useMemo(() => {
    const list = groups.length > 0 ? grouped[selectedGroup] ?? [] : variants;
    const q = query.trim();
    if (!q) return list;

    return list.filter((v) => {
      const title = getVariantTitle(v, groupLabel);
      const sub = getVariantSubtitle(v);
      return `${title} ${sub}`.toLowerCase().includes(q.toLowerCase());
    });
  }, [groupLabel, grouped, groups.length, query, selectedGroup, variants]);

  const toggleExpand = async (variantKey: string) => {
    const isExpanding = !expanded.has(variantKey);

    setExpanded((prev) => {
      const next = new Set(prev);
      if (isExpanding) next.add(variantKey);
      else next.delete(variantKey);
      return next;
    });

    if (!isExpanding) return;
    if (historyByKey[variantKey]) return;
    if (historyLoadingByKey[variantKey]) return;

    setHistoryLoadingByKey((prev) => ({ ...prev, [variantKey]: true }));
    setHistoryErrorByKey((prev) => ({ ...prev, [variantKey]: null }));

    try {
      const history = await api.getVariantHistory(productId, variantKey, 30);
      setHistoryByKey((prev) => ({ ...prev, [variantKey]: history }));
    } catch (e: any) {
      setHistoryErrorByKey((prev) => ({ ...prev, [variantKey]: e?.message || '加载历史失败' }));
    } finally {
      setHistoryLoadingByKey((prev) => ({ ...prev, [variantKey]: false }));
    }
  };

  const formatPrice = (p: number | null) => {
    if (p === null || p === undefined || !Number.isFinite(p)) return '-';
    return `¥${p.toFixed(2)}`;
  };

  const getRecentChange = (variant: Variant) => {
    const latest = variant.finalPrice;
    const prev = variant.prevFinalPrice ?? null;
    if (latest === null || latest === undefined || !Number.isFinite(latest)) return null;
    if (prev === null || prev === undefined || !Number.isFinite(prev)) return null;

    const delta = latest - prev;
    const abs = Math.abs(delta);
    if (!(abs > 0)) return null;

    const percent = prev > 0 ? (abs / prev) * 100 : null;

    const MIN_CHANGE_AMOUNT = 0.1;
    const MIN_CHANGE_PERCENT = 0.5;
    if (abs < MIN_CHANGE_AMOUNT && (percent ?? 0) < MIN_CHANGE_PERCENT) return null;

    return { direction: delta > 0 ? 'UP' : 'DOWN', diff: abs, percent, prev } as const;
  };

  const buildChartData = (history: PriceSnapshot[]) => {
    return (history || []).map((s) => ({
      date: new Date(s.capturedAt).toLocaleString('zh-CN', { 
        month: '2-digit', 
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }),
      price: Number(s.finalPrice),
    }));
  };

  return (
    <div className="bg-gray-50/50">
      <div className="p-4">
        {isLoading ? (
          <div className="h-40 flex items-center justify-center text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
            {error}
          </div>
        ) : variants.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-10">暂无SKU数据</div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="text-xs text-gray-500 font-bold whitespace-nowrap">
                {groupLabel ? `${groupLabel}:` : '规格:'}
              </div>
              <div className="flex-1" />
              <div className="relative w-44">
                <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索SKU"
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-gray-200 bg-white focus:outline-none"
                />
              </div>
            </div>

            {groups.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {groups.map((g) => (
                  <button
                    key={g}
                    onClick={() => setSelectedGroup(g)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                      selectedGroup === g
                        ? 'bg-orange-50 text-orange-700 border-orange-200'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}

            <div className="max-h-[520px] overflow-y-auto space-y-2 pr-1">
              {currentVariants.map((v) => {
                const isOpen = expanded.has(v.variantKey);
                const title = getVariantTitle(v, groupLabel);
                const subtitle = getVariantSubtitle(v);
                const thumb = v.thumbnailUrl || productImageUrl || '';
                const recentChange = getRecentChange(v);

                return (
                  <div
                    key={v.variantKey}
                    className={`bg-white border rounded-xl overflow-hidden ${
                      recentChange
                        ? recentChange.direction === 'DOWN'
                          ? 'border-red-200 ring-1 ring-red-100'
                          : 'border-amber-200 ring-1 ring-amber-100'
                        : 'border-gray-200'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleExpand(v.variantKey)}
                      className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-50"
                    >
                      <div className="w-10 h-10 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0">
                        {thumb ? (
                          <img src={thumb} alt={title} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">
                            无图
                          </div>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-gray-900 truncate" title={title}>
                          {title}
                        </div>
                        {subtitle && (
                          <div className="text-[11px] text-gray-500 truncate" title={subtitle}>
                            {subtitle}
                          </div>
                        )}
                      </div>

                      <div className="text-right flex-shrink-0">
                        <div
                          className={`text-sm font-bold ${
                            recentChange
                              ? recentChange.direction === 'DOWN'
                                ? 'text-red-600'
                                : 'text-amber-800'
                              : 'text-gray-900'
                          }`}
                        >
                          {formatPrice(v.finalPrice)}
                        </div>
                        {recentChange && (
                          <div
                            className={`mt-0.5 inline-flex items-center justify-end gap-1 text-[10px] font-bold ${
                              recentChange.direction === 'DOWN' ? 'text-red-600' : 'text-amber-800'
                            }`}
                          >
                            {recentChange.direction === 'DOWN' ? (
                              <TrendingDown className="w-3 h-3" />
                            ) : (
                              <TrendingUp className="w-3 h-3" />
                            )}
                            <span>
                              {recentChange.direction === 'DOWN' ? '降' : '涨'} {formatPrice(recentChange.diff)}
                              {recentChange.percent !== null ? ` (${recentChange.percent.toFixed(0)}%)` : ''}
                            </span>
                          </div>
                        )}
                        {recentChange && (
                          <div className="text-[10px] text-gray-400">上次 {formatPrice(recentChange.prev)}</div>
                        )}
                        {v.originalPrice && v.finalPrice && v.originalPrice > v.finalPrice && (
                          <div className="text-[11px] text-gray-400 line-through">¥{v.originalPrice.toFixed(2)}</div>
                        )}
                      </div>

                      <div className="text-gray-400 flex-shrink-0">
                        {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-gray-100 bg-gray-50 p-3">
                        {historyLoadingByKey[v.variantKey] ? (
                          <div className="h-[180px] flex items-center justify-center text-gray-400">
                            <Loader2 className="w-5 h-5 animate-spin" />
                          </div>
                        ) : historyErrorByKey[v.variantKey] ? (
                          <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                            {historyErrorByKey[v.variantKey]}
                          </div>
                        ) : (
                          <div className="h-[180px] w-full bg-white rounded-xl p-3 shadow-sm border border-gray-200">
                            <PriceChart data={buildChartData(historyByKey[v.variantKey] || [])} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getVariantTitle(v: Variant, primaryLabel: string) {
  // 优先使用 selections 显示规格
  if (v.selections && v.selections.length > 0) {
    const label = (primaryLabel || '').trim();
    if (!label) return v.selections.map((s) => s.value).join(' / ');

    const rest = v.selections.filter((s) => (s.label || '').trim() !== label);
    if (rest.length > 0) return rest.map((s) => s.value).join(' / ');

    return v.selections.find((s) => (s.label || '').trim() === label)?.value || v.skuProperties || v.variantKey;
  }
  
  // 没有 selections 时，使用 skuProperties（规格文本）
  if (v.skuProperties) return v.skuProperties;
  
  // 兜底使用 variantKey
  return v.variantKey;
}

function getVariantSubtitle(v: Variant) {
  if (!v.selections || v.selections.length === 0) return '';
  const labelPart = v.selections
    .map((s) => {
      const label = s.label || '';
      const value = s.value || '';
      if (!label) return value;
      return `${label}:${value}`;
    })
    .join(' / ');

  return labelPart;
}

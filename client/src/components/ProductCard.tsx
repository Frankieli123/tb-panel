import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, Trash2, ChevronDown, ChevronUp, AlertCircle, TrendingDown, TrendingUp, ShoppingCart, User } from 'lucide-react';
import { Product } from '../types';
import SkuVariantPanel from './SkuVariantPanel';

interface ProductCardProps {
  product: Product;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function ProductCard({ product, onRefresh, onDelete }: ProductCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [, setTick] = useState(0); // 用于强制重新渲染时间显示

  // 每分钟更新一次时间显示
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const recentChange = useMemo(() => {
    const snapshots = product.snapshots || [];
    const latest = snapshots[0]?.finalPrice ?? product.currentPrice;
    const prev = snapshots[1]?.finalPrice ?? null;
    if (latest === null || latest === undefined) return null;
    if (prev === null || prev === undefined) return null;

    const delta = latest - prev;
    const abs = Math.abs(delta);
    if (!(abs > 0)) return null;

    const percent = prev > 0 ? (abs / prev) * 100 : null;

    const MIN_DROP_AMOUNT = 0.1;
    const MIN_DROP_PERCENT = 0.5;
    if (abs < MIN_DROP_AMOUNT && (percent ?? 0) < MIN_DROP_PERCENT) return null;

    return { direction: delta > 0 ? 'UP' : 'DOWN', diff: abs, percent } as const;
  }, [product.currentPrice, product.snapshots]);

  const formatMoney = (n: number) => {
    if (!Number.isFinite(n)) return '-';
    return `¥${n.toFixed(2)}`;
  };

  const getStatusColor = (product: Product) => {
    if (product.lastError) return 'bg-red-100 text-red-700';
    if (!product.isActive) return 'bg-gray-100 text-gray-600';
    return 'bg-green-100 text-green-700';
  };

  const getStatusText = (product: Product) => {
    if (product.lastError) return '异常';
    if (!product.isActive) return '已暂停';
    return '监控中';
  };

  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return '从未';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    return date.toLocaleDateString();
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden transition-all hover:shadow-md">
      {/* Main Card Content */}
      <div className="p-4 md:p-5 flex gap-4">
        {/* Image */}
        <div className="w-20 h-20 md:w-24 md:h-24 bg-gray-100 rounded-lg overflow-hidden flex-shrink-0 relative">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt={product.title || ''} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
              暂无图片
            </div>
          )}
          {recentChange && (
            <div
              className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold shadow-sm ${
                recentChange.direction === 'DOWN'
                  ? 'bg-red-50 text-red-700 border-red-200'
                  : 'bg-amber-50 text-amber-800 border-amber-200'
              }`}
            >
              {recentChange.direction === 'DOWN' ? (
                <TrendingDown className="w-3 h-3" />
              ) : (
                <TrendingUp className="w-3 h-3" />
              )}
              <span>
                {recentChange.direction === 'DOWN' ? '降' : '涨'} {formatMoney(recentChange.diff)}
                {recentChange.percent !== null ? ` (${recentChange.percent.toFixed(0)}%)` : ''}
              </span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 flex flex-col justify-between min-w-0">
          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="font-bold text-gray-900 line-clamp-2 text-sm md:text-base leading-tight">
                {product.title || `商品 ${product.taobaoId}`}
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <div className="text-[11px] md:text-xs text-gray-500 truncate">
                  商品ID：{product.taobaoId}
                </div>
                <div className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border bg-purple-50 text-purple-700 border-purple-200">
                  <ShoppingCart className="w-3 h-3" />
                  购物车
                </div>
              </div>
            </div>
            <a
              href={`https://item.taobao.com/item.htm?id=${product.taobaoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-orange-500 transition-colors flex-shrink-0"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>

          <div className="flex items-end justify-between mt-2">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl md:text-2xl font-bold text-orange-600">
                  {product.currentPrice ? `¥${product.currentPrice}` : '-'}
                </span>
                {recentChange && (
                  <span
                    className={`text-[11px] font-bold border px-2 py-0.5 rounded-full whitespace-nowrap ${
                      recentChange.direction === 'DOWN'
                        ? 'text-red-600 bg-red-50 border-red-100'
                        : 'text-amber-800 bg-amber-50 border-amber-100'
                    }`}
                  >
                    {recentChange.direction === 'DOWN' ? '最近降价' : '最近涨价'}
                  </span>
                )}
                {product.originalPrice && product.currentPrice &&
                 Number(product.originalPrice) > Number(product.currentPrice) && (
                  <span className="text-xs text-gray-400 line-through">
                    ¥{product.originalPrice}
                  </span>
                )}
              </div>
              <p className="text-[10px] md:text-xs text-gray-400">
                更新: {formatTime(product.lastCheckAt)}
              </p>
              {product.monitorMode === 'CART' && product.account && (
                <p className="text-[10px] text-gray-500 flex items-center gap-1 mt-0.5">
                  <User className="w-3 h-3" />
                  {product.account.name}
                </p>
              )}
            </div>

            {/* Mobile Actions (Compact) */}
            <div className="flex gap-2 md:hidden">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1.5 bg-gray-50 rounded-lg text-gray-600"
              >
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Desktop Stats & Actions (Hidden on Mobile) */}
        <div className="hidden md:flex flex-col items-end justify-between border-l border-gray-100 pl-6 ml-2 min-w-[140px]">
          <div className={`px-2.5 py-1 rounded-full text-xs font-bold ${getStatusColor(product)}`}>
            {getStatusText(product)}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onRefresh(product.id)}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 transition-colors"
              title="刷新"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={() => onDelete(product.id)}
              className="p-2 hover:bg-red-50 rounded-lg text-red-500 transition-colors"
              title="删除"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className={`p-2 rounded-lg transition-colors ${
                isExpanded ? 'bg-orange-50 text-orange-600' : 'hover:bg-gray-100 text-gray-500'
              }`}
            >
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {product.lastError && (
        <div className="px-4 pb-2 md:px-5">
          <div className="flex items-center gap-2 text-red-600 text-xs bg-red-50 rounded-lg px-3 py-2">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">{product.lastError}</span>
          </div>
        </div>
      )}

      {/* Expanded Chart Area */}
      {isExpanded && (
        <div className="border-t border-gray-100 bg-gray-50/50 p-4">
          <SkuVariantPanel productId={product.id} productImageUrl={product.imageUrl} />

          {/* Mobile Actions Expanded */}
          <div className="flex justify-between items-center mt-4 md:hidden">
            <div className={`px-3 py-1 rounded-full text-xs font-bold ${getStatusColor(product)}`}>
              {getStatusText(product)}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => onRefresh(product.id)}
                className="flex items-center gap-1 text-sm font-medium text-gray-600 bg-white border border-gray-200 px-3 py-1.5 rounded-lg shadow-sm"
              >
                <RefreshCw className="w-3 h-3" /> 刷新
              </button>
              <button
                onClick={() => onDelete(product.id)}
                className="flex items-center gap-1 text-sm font-medium text-red-600 bg-white border border-red-100 px-3 py-1.5 rounded-lg shadow-sm"
              >
                <Trash2 className="w-3 h-3" /> 删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

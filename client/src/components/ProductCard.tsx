import { useState } from 'react';
import { ExternalLink, RefreshCw, Trash2, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { Product } from '../types';
import PriceChart from './PriceChart';

interface ProductCardProps {
  product: Product;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function ProductCard({ product, onRefresh, onDelete }: ProductCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

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

  // 转换价格历史数据格式
  const chartData = product.snapshots?.map((s) => ({
    date: new Date(s.capturedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }),
    price: Number(s.finalPrice),
  })) || [];

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
        </div>

        {/* Info */}
        <div className="flex-1 flex flex-col justify-between min-w-0">
          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0">
              <h3 className="font-bold text-gray-900 line-clamp-2 text-sm md:text-base leading-tight">
                {product.title || `商品 ${product.taobaoId}`}
              </h3>
              <div className="text-[11px] md:text-xs text-gray-500 mt-1 truncate">
                商品ID：{product.taobaoId}
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
          <div className="h-48 md:h-64 w-full bg-white rounded-xl p-4 shadow-sm border border-gray-200">
            <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
              价格历史 (最近30天)
            </h4>
            <PriceChart data={chartData} />
          </div>

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

import React, { useState, useEffect, useMemo } from 'react';
import { X, Loader2, ShoppingCart, CheckCircle, AlertTriangle, AlertCircle, Copy } from 'lucide-react';
import { api } from '../services/api';
import { TaobaoAccount } from '../types';

interface BatchAddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onTaskStart?: (jobId: string, title: string) => void;
}

interface ParsedUrl {
  original: string;
  url: string;
  isValid: boolean;
  isDuplicate: boolean;
  error?: string;
}

export default function BatchAddProductModal({ isOpen, onClose, onSuccess, onTaskStart }: BatchAddProductModalProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cartAddSkuLimitText, setCartAddSkuLimitText] = useState('');

  const [accounts, setAccounts] = useState<TaobaoAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('auto');

  useEffect(() => {
    if (!isOpen) return;
    loadAccounts();
    setText('');
    setError('');
    setCartAddSkuLimitText('');
  }, [isOpen]);

  const loadAccounts = async () => {
    try {
      const list = await api.getAccounts();
      const activeAccounts = list.filter((a) => a.isActive);
      setAccounts(activeAccounts);
    } catch (err) {
      console.error('Failed to load accounts', err);
    }
  };

  const parsedLinks = useMemo(() => {
    const rawLines = text.split(/[\n,\s]+/).filter(line => line.trim().length > 0);
    const seen = new Set<string>();
    
    return rawLines.map(line => {
      const url = line.trim();
      let isValid = true;
      let errorStr = '';
      
      if (!url.startsWith('http') && !/^\d+$/.test(url)) {
        isValid = false;
        errorStr = '链接格式错误';
      }

      const isDuplicate = seen.has(url);
      if (isValid && !isDuplicate) {
        seen.add(url);
      }

      return {
        original: line,
        url,
        isValid,
        isDuplicate,
        error: errorStr
      } as ParsedUrl;
    });
  }, [text]);

  const stats = useMemo(() => {
    return {
      total: parsedLinks.length,
      valid: parsedLinks.filter(l => l.isValid && !l.isDuplicate).length,
      invalid: parsedLinks.filter(l => !l.isValid).length,
      duplicate: parsedLinks.filter(l => l.isDuplicate).length
    };
  }, [parsedLinks]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const validUrls = parsedLinks
      .filter(l => l.isValid && !l.isDuplicate)
      .map(l => l.url);

    if (validUrls.length === 0) {
      setError('没有有效的商品链接');
      return;
    }

    if (accounts.length === 0) {
      setError('没有可用账号，无法添加任务');
      return;
    }

    if (!selectedAccountId) {
      setError('请选择一个账号');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const cartAddSkuLimit =
        cartAddSkuLimitText.trim().length > 0
          ? Math.max(0, parseInt(cartAddSkuLimitText.trim(), 10) || 0)
          : undefined;
      const { batchJobId, accepted } =
        selectedAccountId === 'auto'
          ? await api.addBatchCartModeProducts(validUrls, undefined, true, cartAddSkuLimit)
          : await api.addBatchCartModeProducts(validUrls, selectedAccountId, false, cartAddSkuLimit);

      if (onTaskStart) {
        const title = `批量添加: ${accepted} 个商品`;
        onTaskStart(batchJobId, title);
      }

      setLoading(false);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量添加失败');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-gray-100 flex justify-between items-center shrink-0">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-orange-500" />
            批量添加商品
          </h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <p className="text-sm text-gray-500 mb-4">
            将多个商品链接粘贴到下方（支持换行、空格或逗号分隔），系统会自动识别有效链接。
          </p>

          <div className="mb-4">
             <div className="relative">
              <textarea
                className="block w-full p-4 border border-gray-200 rounded-xl leading-5 bg-gray-50 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-orange-500 transition-colors resize-y min-h-[120px] font-mono text-sm"
                placeholder={"https://item.taobao.com/item.htm?id=...\nhttps://detail.tmall.com/item.htm?id=..."}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={loading}
              />
              <div className="absolute right-2 bottom-2 text-xs text-gray-400 bg-white/80 px-2 py-1 rounded">
                {text.length} 字符
              </div>
            </div>
          </div>

          {parsedLinks.length > 0 && (
            <div className="flex gap-4 mb-4 text-sm">
              <div className="flex items-center gap-1.5 text-green-600 font-medium bg-green-50 px-3 py-1.5 rounded-lg">
                <CheckCircle className="w-4 h-4" />
                有效: {stats.valid}
              </div>
              {stats.invalid > 0 && (
                <div className="flex items-center gap-1.5 text-red-600 font-medium bg-red-50 px-3 py-1.5 rounded-lg">
                  <AlertCircle className="w-4 h-4" />
                  无效: {stats.invalid}
                </div>
              )}
              {stats.duplicate > 0 && (
                <div className="flex items-center gap-1.5 text-yellow-600 font-medium bg-yellow-50 px-3 py-1.5 rounded-lg">
                  <Copy className="w-4 h-4" />
                  重复: {stats.duplicate}
                </div>
              )}
            </div>
          )}

          {parsedLinks.length > 0 && (
            <div className="mb-4 border border-gray-100 rounded-xl overflow-hidden bg-gray-50/50">
              <div className="max-h-[200px] overflow-y-auto divide-y divide-gray-100">
                {parsedLinks.map((link, idx) => (
                  <div key={idx} className={`flex items-center gap-3 p-3 text-sm ${
                    !link.isValid ? 'bg-red-50/30' : 
                    link.isDuplicate ? 'bg-yellow-50/30' : 'bg-white'
                  }`}>
                    <div className="shrink-0">
                      {!link.isValid ? (
                        <AlertCircle className="w-4 h-4 text-red-500" />
                      ) : link.isDuplicate ? (
                        <AlertTriangle className="w-4 h-4 text-yellow-500" />
                      ) : (
                        <CheckCircle className="w-4 h-4 text-green-500" />
                      )}
                    </div>
                    <div className="flex-1 truncate font-mono text-xs text-gray-600">
                      {link.original}
                    </div>
                    <div className="shrink-0 text-xs font-medium">
                      {!link.isValid ? (
                        <span className="text-red-500">{link.error || '无效'}</span>
                      ) : link.isDuplicate ? (
                        <span className="text-yellow-600">重复已过滤</span>
                      ) : (
                        <span className="text-green-600">准备添加</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">选择账号</label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="block w-full py-2.5 pl-3 pr-10 border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:bg-white focus:ring-2 focus:ring-orange-500 transition-colors text-sm"
              disabled={loading}
            >
              <option value="">请选择账号...</option>
              <option value="auto">自动分配（账号池）</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.status})
                </option>
              ))}
            </select>
            {accounts.length === 0 && (
              <p className="mt-1 text-xs text-red-500">没有可用账号，请先添加并登录账号</p>
            )}
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">加购 SKU 数量（可选）</label>
            <input
              type="number"
              min="0"
              step="1"
              value={cartAddSkuLimitText}
              onChange={(e) => setCartAddSkuLimitText(e.target.value)}
              placeholder="留空=默认；0=全部；N=随机 N 个"
              className="block w-full py-2.5 px-3 border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:bg-white focus:ring-2 focus:ring-orange-500 transition-colors text-sm"
              disabled={loading}
            />
            <p className="mt-1 text-xs text-gray-400">该设置对本次批量任务内所有商品生效。</p>
          </div>

          {error && (
            <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-gray-100 flex gap-3 shrink-0 bg-white rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-xl font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            disabled={loading || stats.valid === 0 || !selectedAccountId || accounts.length === 0}
            className="flex-1 flex justify-center items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : `添加 ${stats.valid} 个商品`}
          </button>
        </div>
      </div>
    </div>
  );
}

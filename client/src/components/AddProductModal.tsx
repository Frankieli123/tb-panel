import React, { useState, useEffect } from 'react';
import { X, Link as LinkIcon, Loader2, ShoppingCart } from 'lucide-react';
import { api } from '../services/api';
import { TaobaoAccount } from '../types';

interface AddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onTaskStart?: (jobId: string, title: string) => void;
}

export default function AddProductModal({ isOpen, onClose, onSuccess, onTaskStart }: AddProductModalProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [accounts, setAccounts] = useState<TaobaoAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('auto');

  useEffect(() => {
    if (!isOpen) return;
    loadAccounts();
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

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) return;

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
      // 购物车模式：启动后台任务并立即关闭弹窗
      const { jobId } =
        selectedAccountId === 'auto'
          ? await api.addCartModeProduct(url.trim(), undefined, true)
          : await api.addCartModeProduct(url.trim(), selectedAccountId);

      // 通知 Dashboard 开始监控此任务
      if (onTaskStart) {
        const taskTitle = `添加商品: ${url.substring(0, 30)}...`;
        onTaskStart(jobId, taskTitle);
      }

      // 立即关闭弹窗并重置状态
      setUrl('');
      setLoading(false);
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="p-5 border-b border-gray-100 flex justify-between items-center">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-orange-500" />
            添加商品（购物车模式）
          </h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <p className="text-sm text-gray-500 mb-4">
            自动将商品的所有 SKU 加入购物车，并通过购物车抓取精准价格（需要选择已登录账号）。
          </p>

          <div className="relative mb-4">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <LinkIcon className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl leading-5 bg-gray-50 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-orange-500 transition-colors"
              placeholder="https://m.tb.cn/... 或商品ID"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
            />
          </div>

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

          {error && (
            <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex gap-3">
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
              disabled={loading || !url.trim() || !selectedAccountId || accounts.length === 0}
              className="flex-1 flex justify-center items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : '开始监控'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

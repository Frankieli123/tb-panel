import { useEffect, useMemo, useState } from 'react';
import { Copy, Key, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { api } from '../services/api';
import type { InviteCode } from '../types';

function formatDateTime(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function getInviteStatus(invite: InviteCode): 'active' | 'disabled' | 'used' | 'deleted' {
  if (invite.deletedAt) return 'deleted';
  if (invite.usedAt) return 'used';
  if (!invite.isActive || invite.disabledAt) return 'disabled';
  return 'active';
}

function StatusBadge({ status }: { status: ReturnType<typeof getInviteStatus> }) {
  const cls =
    status === 'active'
      ? 'bg-green-50 text-green-700 ring-green-200'
      : status === 'used'
        ? 'bg-blue-50 text-blue-700 ring-blue-200'
        : status === 'disabled'
          ? 'bg-amber-50 text-amber-800 ring-amber-200'
          : 'bg-gray-100 text-gray-700 ring-gray-200';

  const label =
    status === 'active'
      ? '可用'
      : status === 'used'
        ? '已使用'
        : status === 'disabled'
          ? '已失效'
          : '已删除';

  return (
    <span className={`inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full ring-1 ${cls}`}>
      {label}
    </span>
  );
}

export default function InviteCodes() {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCreatedCode, setLastCreatedCode] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.listInviteCodes();
      setCodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onCreate = async () => {
    setError(null);
    try {
      const created = await api.createInviteCode();
      setLastCreatedCode(created.code);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError('复制失败：浏览器未授权剪贴板');
    }
  };

  const onDisable = async (id: string) => {
    if (!window.confirm('确认让该邀请码失效？')) return;
    setError(null);
    try {
      await api.disableInviteCode(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('确认删除（软删）该邀请码？')) return;
    setError(null);
    try {
      await api.deleteInviteCode(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rows = useMemo(() => {
    return codes.map((c) => ({
      ...c,
      status: getInviteStatus(c),
    }));
  }, [codes]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight">邀请码管理</h1>
          <p className="mt-1 text-sm text-gray-500">仅管理员可见。邀请码一次使用，可失效或软删除。</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="w-4 h-4" />
            刷新
          </button>
          <button
            type="button"
            onClick={() => void onCreate()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-orange-600 text-white font-semibold hover:bg-orange-700"
          >
            <Key className="w-4 h-4" />
            生成邀请码
          </button>
        </div>
      </div>

      {lastCreatedCode ? (
        <div className="bg-white border border-orange-100 rounded-2xl p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-gray-700">最新生成</div>
              <div className="mt-1 font-mono text-lg text-orange-700 tracking-wider">{lastCreatedCode}</div>
            </div>
            <button
              type="button"
              onClick={() => void copyText(lastCreatedCode)}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100"
            >
              <Copy className="w-4 h-4" />
              复制
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-700 text-sm">{error}</div>
      ) : null}

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-semibold text-gray-600">
                <th className="px-4 py-3">邀请码</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">创建</th>
                <th className="px-4 py-3">使用</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-gray-500" colSpan={5}>
                    加载中...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-gray-500" colSpan={5}>
                    暂无邀请码
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="text-sm">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-orange-700 font-semibold tracking-wider">{row.code}</span>
                        <button
                          type="button"
                          onClick={() => void copyText(row.code)}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:text-orange-700 hover:bg-orange-50"
                          title="复制"
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div className="leading-5">
                        <div>{formatDateTime(row.createdAt)}</div>
                        <div className="text-xs text-gray-500">
                          {row.createdBy ? `by ${row.createdBy.username}` : '-'}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div className="leading-5">
                        <div>{formatDateTime(row.usedAt)}</div>
                        <div className="text-xs text-gray-500">{row.usedBy ? `by ${row.usedBy.username}` : '-'}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          disabled={row.status !== 'active'}
                          onClick={() => void onDisable(row.id)}
                          className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent"
                          title="失效"
                        >
                          <ShieldAlert className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          disabled={row.status === 'deleted'}
                          onClick={() => void onDelete(row.id)}
                          className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent"
                          title="删除（软删）"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, useRef, useCallback } from 'react';
import { Plus, Cookie, Trash2, AlertTriangle, Play, Pause, QrCode, X, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import { getLoginWsUrl } from '../services/api';
import type { AgentConnection, TaobaoAccount } from '../types';
import AgentManager from '../components/AgentManager';

interface LoginState {
  accountId: string;
  status: 'connecting' | 'started' | 'scanning' | 'success' | 'error';
  screenshot?: string;
  message?: string;
}

export default function Accounts() {
  const [accounts, setAccounts] = useState<TaobaoAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [agents, setAgents] = useState<AgentConnection[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [bindingAccountId, setBindingAccountId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCookieModal, setShowCookieModal] = useState<string | null>(null);
  const [newAccountName, setNewAccountName] = useState('');
  const [cookieInput, setCookieInput] = useState('');
  const [loginState, setLoginState] = useState<LoginState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    loadAccounts();
    loadAgents();
  }, []);

  // 清理 WebSocket 连接
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const bindAgentToAccount = useCallback(async (accountId: string, agentId: string | null) => {
    const previousAgentId = accounts.find((a) => a.id === accountId)?.agentId ?? null;

    setBindingAccountId(accountId);
    setAccounts((prev) => prev.map((a) => (a.id === accountId ? { ...a, agentId } : a)));

    try {
      await api.updateAccountAgent(accountId, agentId);
    } catch (error) {
      console.error('Failed to bind agent:', error);
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, agentId: previousAgentId } : a))
      );
      alert(`绑定失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBindingAccountId(null);
    }
  }, [accounts]);

  const startLogin = useCallback((accountId: string) => {
    // 关闭现有连接
    if (wsRef.current) {
      wsRef.current.close();
    }

    setLoginState({ accountId, status: 'connecting' });

    // 创建 WebSocket 连接
    const ws = new WebSocket(getLoginWsUrl());
    wsRef.current = ws;
    let opened = false;
    const connectTimeout = window.setTimeout(() => {
      if (opened) return;
      try {
        ws.close();
      } catch {}
      setLoginState((prev) =>
        prev && prev.accountId === accountId
          ? {
              ...prev,
              status: 'error',
              message: '登录连接超时：请确认后端已启动，并且你已登录面板（会话未过期）',
            }
          : prev
      );
    }, 10_000);

    ws.onopen = () => {
      opened = true;
      window.clearTimeout(connectTimeout);
      setLoginState((prev) =>
        prev && prev.accountId === accountId ? { ...prev, status: 'started' } : prev
      );
      ws.send(JSON.stringify({ type: 'start_login', accountId }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'login_started':
          setLoginState(prev => prev ? { ...prev, status: 'started' } : null);
          break;
        case 'screenshot':
          setLoginState(prev => prev ? { ...prev, status: 'scanning', screenshot: data.image } : null);
          break;
        case 'login_success':
          setLoginState(prev => prev ? { ...prev, status: 'success', message: data.message } : null);
          loadAccounts();
          setTimeout(() => {
            setLoginState(null);
          }, 2000);
          break;
        case 'login_cancelled':
          setLoginState(null);
          break;
        case 'error':
          setLoginState(prev => prev ? { ...prev, status: 'error', message: data.message } : null);
          break;
      }
    };

    ws.onerror = () => {
      window.clearTimeout(connectTimeout);
      setLoginState(prev => prev ? { ...prev, status: 'error', message: '连接失败' } : null);
    };

    ws.onclose = (event) => {
      window.clearTimeout(connectTimeout);
      wsRef.current = null;

      // 如果 WS 连接被拒绝/异常断开，避免 UI 一直停留在“连接中”转圈
      setLoginState((prev) => {
        if (!prev) return prev;
        if (prev.accountId !== accountId) return prev;
        if (prev.status === 'success' || prev.status === 'error') return prev;

        const code = typeof event?.code === 'number' ? event.code : 0;
        const reason =
          typeof event?.reason === 'string' && event.reason ? `（${event.reason}）` : '';
        const message =
          code === 1008
            ? `登录被拒绝${reason}：请确认你已登录面板（或刷新页面重新登录）`
            : `登录连接已断开${reason}：请确认后端正常运行`;

        return { ...prev, status: 'error', message };
      });
    };
  }, []);

  const cancelLogin = useCallback(() => {
    if (wsRef.current && loginState) {
      wsRef.current.send(JSON.stringify({ type: 'cancel_login', accountId: loginState.accountId }));
      wsRef.current.close();
    }
    setLoginState(null);
  }, [loginState]);

  const loadAccounts = async () => {
    setIsLoading(true);
    try {
      const data = await api.getAccounts();
      setAccounts(data);
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadAgents = async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const data = await api.getAgents();
      setAgents(data);
    } catch (error) {
      console.error('Failed to load agents:', error);
      setAgentsError(error instanceof Error ? error.message : 'Failed to load agents');
    } finally {
      setAgentsLoading(false);
    }
  };

  const handleAddAccount = async () => {
    if (!newAccountName.trim()) return;
    try {
      await api.addAccount(newAccountName.trim());
      setNewAccountName('');
      setShowAddModal(false);
      await loadAccounts();
    } catch (error) {
      console.error('Failed to add account:', error);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!confirm('确定要删除这个账号吗？')) return;
    try {
      await api.deleteAccount(id);
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (error) {
      console.error('Failed to delete account:', error);
    }
  };

  const handleToggleAccount = async (id: string) => {
    try {
      await api.toggleAccount(id);
      setAccounts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, isActive: !a.isActive } : a))
      );
    } catch (error) {
      console.error('Failed to toggle account:', error);
    }
  };

  const handleUpdateCookies = async () => {
    if (!showCookieModal || !cookieInput.trim()) return;
    try {
      await api.updateAccountCookies(showCookieModal, cookieInput.trim());
      setCookieInput('');
      setShowCookieModal(null);
      await loadAccounts();
    } catch (error) {
      console.error('Failed to update cookies:', error);
      alert('更新失败，请检查Cookie格式');
    }
  };

  const getStatusBadge = (account: TaobaoAccount) => {
    if (!account.isActive) {
      return <span className="text-xs font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">已禁用</span>;
    }
    switch (account.status) {
      case 'RUNNING':
        return <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full animate-pulse">抓取中</span>;
      case 'CAPTCHA':
        return <span className="text-xs font-bold text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded-full">需验证</span>;
      case 'LOCKED':
        return <span className="text-xs font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">已锁定</span>;
      case 'COOLDOWN':
        return <span className="text-xs font-bold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">冷却中</span>;
      default:
        return <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">正常</span>;
    }
  };

  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return '从未';
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const onlineAgentIds = new Set(agents.map((a) => a.agentId));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">账号管理</h2>
        <p className="text-gray-500 text-sm mt-1">
          管理用于抓取的淘宝账号，<span className="text-red-500 font-medium">请勿使用主账号</span>
        </p>
      </div>

      {/* Info Banner */}
      <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 flex gap-3 text-amber-800 text-sm">
        <AlertTriangle className="w-5 h-5 flex-shrink-0" />
        <div>
          <p className="font-medium">登录说明</p>
          <p className="mt-1 text-amber-700">
            点击"登录"后，会弹出淘宝登录页面。您可以使用淘宝 App 扫描二维码，或直接输入账号密码登录。
            登录成功后会自动保存状态。推荐使用小号登录以降低风险。
          </p>
        </div>
      </div>

      <AgentManager 
        agents={agents}
        isLoading={agentsLoading}
        error={agentsError}
        onRefresh={loadAgents}
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-40 bg-gray-100 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Account Cards */}
          {accounts.map((account) => (
            <div
              key={account.id}
              className={`bg-white p-6 rounded-2xl border shadow-sm ${
                account.isActive ? 'border-gray-200' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-orange-400 to-pink-500 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                    {account.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-bold text-gray-900 truncate">{account.name}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      {getStatusBadge(account)}
                      {account._count && (
                        <span className="text-xs text-gray-400">
                          {account._count.products} 个商品
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleToggleAccount(account.id)}
                  className={`p-2 rounded-lg transition-colors ${
                    account.isActive
                      ? 'text-green-600 hover:bg-green-50'
                      : 'text-gray-400 hover:bg-gray-100'
                  }`}
                  title={account.isActive ? '禁用' : '启用'}
                >
                  {account.isActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
              </div>

              <div className="mt-4 text-xs text-gray-500 space-y-1">
                <p>上次登录: {formatTime(account.lastLoginAt)}</p>
                {account.lastError && (
                  <p className="text-red-500 truncate" title={account.lastError}>
                    错误: {account.lastError}
                  </p>
                )}
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-gray-500">执行机（Agent）</p>
                  {account.agentId ? (
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                        onlineAgentIds.has(account.agentId)
                          ? 'bg-green-50 text-green-700 border-green-100'
                          : 'bg-red-50 text-red-700 border-red-100'
                      }`}
                      title={account.agentId}
                    >
                      {onlineAgentIds.has(account.agentId) ? '在线' : '离线'}
                    </span>
                  ) : (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-50 text-gray-600 border border-gray-100">
                      未绑定
                    </span>
                  )}
                </div>

                <select
                  className="mt-2 w-full px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:opacity-60"
                  value={account.agentId ?? ''}
                  disabled={bindingAccountId === account.id}
                  onChange={(e) => void bindAgentToAccount(account.id, e.target.value ? e.target.value : null)}
                >
                  <option value="">自动（跟随默认执行机）</option>
                  {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.agentId}
                    </option>
                  ))}
                  {!!account.agentId && !onlineAgentIds.has(account.agentId) && (
                    <option value={account.agentId}>离线：{account.agentId}</option>
                  )}
                </select>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => void startLogin(account.id)}
                  className="flex-1 min-w-[120px] flex items-center justify-center gap-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 py-2 rounded-lg transition-colors"
                >
                  <QrCode className="w-4 h-4" /> 登录
                </button>
                <button
                  onClick={() => setShowCookieModal(account.id)}
                  className="flex-none flex items-center justify-center gap-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 px-3 py-2 rounded-lg transition-colors"
                  title="手动输入Cookie"
                >
                  <Cookie className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDeleteAccount(account.id)}
                  className="flex-none px-3 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}

          {/* Add New Card */}
          <button
            onClick={() => setShowAddModal(true)}
            className="flex flex-col items-center justify-center gap-3 bg-gray-50 border-2 border-dashed border-gray-300 rounded-2xl min-h-[240px] h-full hover:border-orange-400 hover:bg-orange-50/50 transition-all group"
          >
            <div className="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center group-hover:scale-110 transition-transform">
              <Plus className="w-5 h-5 text-orange-500" />
            </div>
            <span className="text-sm font-bold text-gray-500 group-hover:text-orange-600">
              添加新账号
            </span>
          </button>
        </div>
      )}

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-xl p-6">
            <h3 className="text-lg font-bold mb-4">添加新账号</h3>
            <input
              type="text"
              placeholder="账号备注名（如：小号1）"
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 mb-4"
              autoFocus
            />
            <div className="flex gap-3">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 px-4 py-2.5 rounded-xl font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
              >
                取消
              </button>
              <button
                onClick={handleAddAccount}
                disabled={!newAccountName.trim()}
                className="flex-1 px-4 py-2.5 rounded-xl font-bold text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cookie Modal */}
      {showCookieModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl p-6">
            <h3 className="text-lg font-bold mb-2">更新 Cookie</h3>
            <p className="text-sm text-gray-500 mb-4">
              请粘贴从浏览器导出的Cookie（JSON格式数组）
            </p>
            <textarea
              placeholder='[{"name": "...", "value": "...", "domain": ".taobao.com", ...}]'
              value={cookieInput}
              onChange={(e) => setCookieInput(e.target.value)}
              className="w-full h-40 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 mb-4 font-mono text-sm"
              autoFocus
            />
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowCookieModal(null);
                  setCookieInput('');
                }}
                className="flex-1 px-4 py-2.5 rounded-xl font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
              >
                取消
              </button>
              <button
                onClick={handleUpdateCookies}
                disabled={!cookieInput.trim()}
                className="flex-1 px-4 py-2.5 rounded-xl font-bold text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Code Login Modal */}
      {loginState && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
              <h3 className="text-lg font-bold">淘宝登录</h3>
              <button
                onClick={cancelLogin}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              {loginState.status === 'connecting' && (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
                  <p className="mt-4 text-gray-500">正在连接...</p>
                </div>
              )}

              {loginState.status === 'started' && (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
                  <p className="mt-4 text-gray-500">正在打开登录页面...</p>
                </div>
              )}

              {(loginState.status === 'scanning' || loginState.screenshot) && (
                <div className="flex flex-col items-center w-full">
                  <div className="relative bg-gray-50 rounded-xl overflow-hidden w-full flex items-center justify-center border border-gray-200 min-h-[300px] md:min-h-[500px]">
                    {loginState.screenshot ? (
                      <img
                        src={`data:image/jpeg;base64,${loginState.screenshot}`}
                        alt="Login Page"
                        className="w-full h-auto object-contain max-h-[50vh] md:max-h-[700px]"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center text-gray-400 py-20">
                        <Loader2 className="w-8 h-8 mb-2 animate-spin" />
                        <span>等待画面...</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-4 text-sm text-gray-500 text-center">
                    请使用淘宝 App 扫描二维码，或在上方输入账号密码登录
                  </p>
                </div>
              )}

              {loginState.status === 'success' && (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                    <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="mt-4 text-green-600 font-medium">{loginState.message || '登录成功！'}</p>
                </div>
              )}

              {loginState.status === 'error' && (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
                    <X className="w-8 h-8 text-red-500" />
                  </div>
                  <p className="mt-4 text-red-600 font-medium">{loginState.message || '登录失败'}</p>
                  <button
                    onClick={() => void startLogin(loginState.accountId)}
                    className="mt-4 px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg"
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

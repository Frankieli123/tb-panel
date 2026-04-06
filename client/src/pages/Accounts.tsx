import { useEffect, useState, useRef, useCallback, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Plus, Cookie, Trash2, AlertTriangle, Play, Pause, QrCode, X, Loader2, Monitor, ShoppingCart, RefreshCw } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../services/api';
import { getLoginWsUrl } from '../services/api';
import type { AgentConnection, TaobaoAccount } from '../types';
import AgentManager from '../components/AgentManager';

interface LoginState {
  accountId: string;
  status: 'connecting' | 'started' | 'scanning' | 'success' | 'error';
  mode?: 'local' | 'agent';
  displayMode: 'qr' | 'page';
  pageModeLocked?: boolean;
  qrUrl?: string;
  qrImage?: string;
  screenshot?: string;
  message?: string;
}

interface ScreenshotState {
  accountId: string;
  loading: boolean;
  image?: string;
  error?: string;
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
  const [screenshotState, setScreenshotState] = useState<ScreenshotState | null>(null);
  const [refreshingCartIds, setRefreshingCartIds] = useState<Set<string>>(new Set());
  const [loginControlText, setLoginControlText] = useState('');
  const [loginControlBusy, setLoginControlBusy] = useState(false);
  const [loginControlError, setLoginControlError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cartRefreshPollersRef = useRef<Map<string, number>>(new Map());
  const cartRefreshJobIdsRef = useRef<Map<string, string>>(new Map());
  const loginImageRef = useRef<HTMLImageElement | null>(null);
  const loginPointerStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void loadAccounts();
    void loadAgents();
  }, []);

  // 清理 WebSocket 连接
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      for (const timer of cartRefreshPollersRef.current.values()) {
        window.clearTimeout(timer);
      }
      cartRefreshPollersRef.current.clear();
      cartRefreshJobIdsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!loginState) {
      setLoginControlBusy(false);
      setLoginControlError(null);
      setLoginControlText('');
      loginPointerStartRef.current = null;
    }
  }, [loginState]);

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

  const captureAccountScreenshot = async (accountId: string) => {
    setScreenshotState({ accountId, loading: true });
    try {
      const data = await api.getAccountBrowserScreenshot(accountId);
      setScreenshotState({ accountId, loading: false, image: data.image });
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
      setScreenshotState({
        accountId,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const sendLoginControl = useCallback((payload: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !loginState) return false;
    if (loginState.mode !== 'agent' || loginState.displayMode !== 'page') return false;
    setLoginControlBusy(true);
    setLoginControlError(null);
    wsRef.current.send(JSON.stringify({ type: 'login_control', accountId: loginState.accountId, ...payload }));
    return true;
  }, [loginState]);

  const mapImageEventPoint = useCallback((event: ReactMouseEvent<HTMLImageElement>) => {
    const img = loginImageRef.current ?? event.currentTarget;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;
    if (!naturalWidth || !naturalHeight) return null;

    const naturalRatio = naturalWidth / naturalHeight;
    const boxRatio = rect.width / rect.height;
    let renderedWidth = rect.width;
    let renderedHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (boxRatio > naturalRatio) {
      renderedWidth = rect.height * naturalRatio;
      offsetX = (rect.width - renderedWidth) / 2;
    } else if (boxRatio < naturalRatio) {
      renderedHeight = rect.width / naturalRatio;
      offsetY = (rect.height - renderedHeight) / 2;
    }

    const localX = event.clientX - rect.left - offsetX;
    const localY = event.clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) return null;

    return {
      x: (localX * naturalWidth) / renderedWidth,
      y: (localY * naturalHeight) / renderedHeight,
    };
  }, []);

  const handleLoginImageMouseDown = useCallback((event: ReactMouseEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    if (loginControlBusy) return;
    const point = mapImageEventPoint(event);
    loginPointerStartRef.current = point;
  }, [loginControlBusy, mapImageEventPoint]);

  const handleLoginImageMouseUp = useCallback((event: ReactMouseEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    if (loginControlBusy) return;
    const start = loginPointerStartRef.current;
    loginPointerStartRef.current = null;
    const end = mapImageEventPoint(event);
    if (!start || !end) return;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const moved = Math.hypot(dx, dy);

    if (moved >= 12) {
      void sendLoginControl({
        action: 'drag',
        fromX: Math.round(start.x),
        fromY: Math.round(start.y),
        toX: Math.round(end.x),
        toY: Math.round(end.y),
      });
      return;
    }

    void sendLoginControl({
      action: 'click',
      x: Math.round(end.x),
      y: Math.round(end.y),
    });
  }, [loginControlBusy, mapImageEventPoint, sendLoginControl]);

  const handleSendLoginText = useCallback(() => {
    const text = loginControlText;
    if (!text.trim()) return;
    if (sendLoginControl({ action: 'type', text })) {
      setLoginControlText('');
    }
  }, [loginControlText, sendLoginControl]);

  const handleLoginTextKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleSendLoginText();
  }, [handleSendLoginText]);

  const handleLoginQuickKey = useCallback((key: string) => {
    void sendLoginControl({ action: 'key', key });
  }, [sendLoginControl]);

  const startLogin = useCallback((accountId: string) => {
    // 关闭现有连接
    if (wsRef.current) {
      wsRef.current.close();
    }

    setLoginControlBusy(false);
    setLoginControlError(null);
    setLoginControlText('');
    loginPointerStartRef.current = null;
    setLoginState({ accountId, status: 'connecting', displayMode: 'page' });

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
        prev && prev.accountId === accountId ? { ...prev, status: 'started', message: undefined } : prev
      );
      ws.send(JSON.stringify({ type: 'start_login', accountId }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'login_started':
          setLoginControlBusy(false);
          setLoginControlError(null);
          setLoginState(prev => prev ? {
            ...prev,
            status: 'started',
            mode: data.mode === 'agent' || data.mode === 'local' ? data.mode : prev.mode,
            message: undefined,
          } : null);
          break;
        case 'login_qr':
          setLoginState((prev) => {
            if (!prev) return prev;
            const next = {
              ...prev,
              status: 'scanning' as const,
              qrUrl: typeof data.qrUrl === 'string' && data.qrUrl ? data.qrUrl : prev.qrUrl,
              qrImage: typeof data.qrImage === 'string' && data.qrImage ? data.qrImage : prev.qrImage,
              message: '请使用淘宝 App 扫描二维码登录',
            };
            return prev.pageModeLocked ? next : { ...next, displayMode: 'qr' as const };
          });
          break;
        case 'login_fallback':
          setLoginState((prev) =>
            prev
                ? {
                    ...prev,
                    status: 'scanning',
                    displayMode: 'page',
                    pageModeLocked: true,
                    message: data.reason || '已切换为完整页面登录',
                  }
                : null
          );
          break;
        case 'login_verify_required':
          setLoginState((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'scanning',
                  displayMode: 'page',
                  pageModeLocked: true,
                  message: data.reason || '检测到验证码/安全验证，已切到完整页面；可直接在当前窗口远程操作，必要时再到 Agent 机器处理',
                }
              : null
          );
          break;
        case 'screenshot':
          setLoginControlBusy(false);
          setLoginControlError(null);
          setLoginState(prev => prev ? { ...prev, status: 'scanning', screenshot: data.image } : null);
          break;
        case 'login_control_error':
          setLoginControlBusy(false);
          setLoginControlError(data.message || '远程控制失败');
          break;
        case 'login_success':
          setLoginControlBusy(false);
          setLoginState(prev => prev ? { ...prev, status: 'success', message: data.message } : null);
          loadAccounts();
          setTimeout(() => {
            setLoginState(null);
          }, 2000);
          break;
        case 'login_cancelled':
          setLoginControlBusy(false);
          setLoginState(null);
          break;
        case 'error':
          setLoginControlBusy(false);
          setLoginState(prev => prev ? { ...prev, status: 'error', message: data.message } : null);
          break;
      }
    };

    ws.onerror = () => {
      window.clearTimeout(connectTimeout);
      setLoginControlBusy(false);
      setLoginState(prev => prev ? { ...prev, status: 'error', message: '连接失败' } : null);
    };

    ws.onclose = (event) => {
      window.clearTimeout(connectTimeout);
      wsRef.current = null;
      setLoginControlBusy(false);

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

  const showFullLoginPage = useCallback(() => {
    setLoginState((prev) => (prev ? { ...prev, displayMode: 'page', pageModeLocked: true } : prev));
  }, []);

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api.getAccounts();
      setAccounts(data);
    } catch (error) {
      console.error('Failed to load accounts:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadAgents = useCallback(async () => {
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
  }, []);

  const clearCartRefreshPolling = useCallback((accountId: string) => {
    const timer = cartRefreshPollersRef.current.get(accountId);
    if (timer) {
      window.clearTimeout(timer);
      cartRefreshPollersRef.current.delete(accountId);
    }
    cartRefreshJobIdsRef.current.delete(accountId);
    setRefreshingCartIds((prev) => {
      if (!prev.has(accountId)) return prev;
      const next = new Set(prev);
      next.delete(accountId);
      return next;
    });
  }, []);

  const pollCartRefreshJob = useCallback(
    async (accountId: string, jobId: string, failureCount = 0) => {
      cartRefreshJobIdsRef.current.set(accountId, jobId);
      try {
        const data = await api.getCartScrapeProgress(jobId);
        if (cartRefreshJobIdsRef.current.get(accountId) !== jobId) {
          return;
        }
        const active = data.status === 'pending' || data.status === 'running';
        if (active) {
          const delay = failureCount > 0 ? Math.min(10_000, 2_000 * (failureCount + 1)) : 2_000;
          const timer = window.setTimeout(() => {
            void pollCartRefreshJob(accountId, jobId, 0);
          }, delay);
          cartRefreshPollersRef.current.set(accountId, timer);
          return;
        }

        await loadAccounts();
        if (cartRefreshJobIdsRef.current.get(accountId) !== jobId) {
          return;
        }
        clearCartRefreshPolling(accountId);

        if (data.status === 'failed') {
          const message = data.logs[data.logs.length - 1] || '购物车刷新失败';
          alert(`刷新失败：${message}`);
        }
      } catch (error) {
        if (cartRefreshJobIdsRef.current.get(accountId) !== jobId) {
          return;
        }
        const nextFailureCount = failureCount + 1;
        if (nextFailureCount >= 5) {
          console.error('Failed to poll cart refresh progress:', error);
          clearCartRefreshPolling(accountId);
          alert(`刷新失败：${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        const delay = Math.min(10_000, 2_000 * nextFailureCount);
        const timer = window.setTimeout(() => {
          void pollCartRefreshJob(accountId, jobId, nextFailureCount);
        }, delay);
        cartRefreshPollersRef.current.set(accountId, timer);
      }
    },
    [clearCartRefreshPolling, loadAccounts]
  );

  const handleRefreshCart = async (accountId: string) => {
    setRefreshingCartIds((prev) => {
      const next = new Set(prev);
      next.add(accountId);
      return next;
    });

    try {
      const { jobId } = await api.queueCartScrape(accountId);
      const existingTimer = cartRefreshPollersRef.current.get(accountId);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
      }
      void pollCartRefreshJob(accountId, jobId, 0);
    } catch (error) {
      console.error('Failed to refresh cart:', error);
      clearCartRefreshPolling(accountId);
      alert(`刷新失败：${error instanceof Error ? error.message : String(error)}`);
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
  const canRemoteControlLoginPage =
    !!loginState &&
    loginState.mode === 'agent' &&
    loginState.displayMode === 'page' &&
    loginState.status === 'scanning' &&
    !!loginState.screenshot;
  const loginModeLabel =
    loginState?.mode === 'agent'
      ? 'Agent 模式'
      : loginState?.mode === 'local'
        ? 'Local 模式'
        : null;

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
            点击"登录"后，会启动淘宝登录流程。绑定 Agent 的账号会优先显示二维码供扫码，
            异常时会自动切回完整页面。登录成功后会自动保存状态，推荐使用小号登录以降低风险。
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

                <div className="flex items-center gap-4 text-xs text-gray-500 mt-2">
                  <div className="flex items-center gap-1.5" title="购物车SKU统计">
                    <ShoppingCart className="w-3.5 h-3.5" />
                    <span>
                      {account.cartSkuLoaded !== null && account.cartSkuLoaded !== undefined
                        ? account.cartSkuLoaded
                        : '-'}{' '}
                      / {account.cartSkuTotal !== null && account.cartSkuTotal !== undefined
                        ? account.cartSkuTotal
                        : '-'}
                    </span>
                  </div>

                  <button
                    onClick={() => void handleRefreshCart(account.id)}
                    disabled={refreshingCartIds.has(account.id)}
                    className={`p-1 rounded hover:bg-gray-100 transition-colors ${
                      refreshingCartIds.has(account.id) ? 'text-orange-500' : 'text-gray-400 hover:text-orange-500'
                    }`}
                    title="刷新购物车统计"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshingCartIds.has(account.id) ? 'animate-spin' : ''}`} />
                  </button>

                  {account.cartSkuUpdatedAt && (
                    <span className="text-gray-400">{formatTime(account.cartSkuUpdatedAt)}</span>
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
                  onClick={() => void captureAccountScreenshot(account.id)}
                  className="flex-none flex items-center justify-center gap-2 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 px-3 py-2 rounded-lg transition-colors"
                  title="查看当前 Agent 浏览器画面（单次截图）"
                >
                  <Monitor className="w-4 h-4" />
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
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-bold">淘宝登录</h3>
                {loginModeLabel && (
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                      loginState.mode === 'agent'
                        ? 'bg-green-50 text-green-700 border-green-100'
                        : 'bg-amber-50 text-amber-700 border-amber-100'
                    }`}
                  >
                    {loginModeLabel}
                  </span>
                )}
              </div>
              <button
                onClick={cancelLogin}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 min-h-0">
              {loginState.mode && (
                <div
                  className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
                    loginState.mode === 'agent'
                      ? 'bg-green-50 border-green-100 text-green-800'
                      : 'bg-amber-50 border-amber-100 text-amber-800'
                  }`}
                >
                  {loginState.mode === 'agent'
                    ? '当前使用 Agent 登录。遇到验证码或安全验证时，可切到完整页面后直接在此窗口远程操作。'
                    : '当前使用 Local 登录。本地模式只同步登录画面，不显示网页远程输入/点按控件。'}
                </div>
              )}

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
                  {loginState.displayMode === 'qr' && (loginState.qrUrl || loginState.qrImage) ? (
                    <>
                      <div className="w-full rounded-2xl border border-gray-200 bg-white p-6 md:p-8 flex flex-col items-center">
                        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
                          {loginState.qrImage ? (
                            <img src={loginState.qrImage} alt="Taobao QR Code" className="w-[220px] h-[220px] object-contain" />
                          ) : (
                            <QRCodeSVG value={loginState.qrUrl || ''} size={220} includeMargin />
                          )}
                        </div>
                        <p className="mt-5 text-base font-medium text-gray-900">请使用淘宝 App 扫码登录</p>
                        <p className="mt-2 text-sm text-gray-500 text-center">
                          二维码来自当前 Agent 登录会话。若扫码页异常，可切换查看完整登录页面。
                        </p>
                        <button
                          onClick={showFullLoginPage}
                          className="mt-5 px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg"
                        >
                          查看完整页面
                        </button>
                      </div>
                      {loginState.message && (
                        <p className="mt-4 text-sm text-gray-500 text-center">{loginState.message}</p>
                      )}
                    </>
	                  ) : (
	                    <>
	                      <div className="relative bg-gray-50 rounded-xl overflow-hidden w-full flex items-center justify-center border border-gray-200 min-h-[300px] md:min-h-[500px]">
	                        {loginState.screenshot ? (
	                          <>
	                            <img
	                              ref={loginImageRef}
	                              src={`data:image/jpeg;base64,${loginState.screenshot}`}
	                              alt="Login Page"
	                              onMouseDown={canRemoteControlLoginPage ? handleLoginImageMouseDown : undefined}
	                              onMouseUp={canRemoteControlLoginPage ? handleLoginImageMouseUp : undefined}
	                              className={`w-full h-auto object-contain max-h-[50vh] md:max-h-[700px] ${
	                                canRemoteControlLoginPage ? 'cursor-crosshair select-none' : ''
	                              }`}
	                              draggable={false}
	                            />
	                            {canRemoteControlLoginPage && loginControlBusy && (
	                              <div className="absolute inset-0 flex items-center justify-center bg-black/10 pointer-events-none">
	                                <div className="px-3 py-1.5 rounded-full bg-black/70 text-white text-sm">
	                                  正在发送操作...
	                                </div>
	                              </div>
	                            )}
	                          </>
	                        ) : (
	                          <div className="flex flex-col items-center justify-center text-gray-400 py-20">
	                            <Loader2 className="w-8 h-8 mb-2 animate-spin" />
	                            <span>等待画面...</span>
	                          </div>
	                        )}
	                      </div>
	                      <p className="mt-4 text-sm text-gray-500 text-center">
	                        {loginState.message || '请使用淘宝 App 扫描二维码，或在上方输入账号密码登录'}
	                      </p>
	                    </>
	                  )}
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
            {canRemoteControlLoginPage && (
              <div className="border-t border-gray-200 bg-white/95 backdrop-blur p-4 flex-shrink-0">
                <div className="w-full rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
                  <div className="text-sm text-gray-700">
                    <span className="font-medium">远程控制已启用：</span>
                    点击截图可点页面，拖动截图可操作滑块；先点击输入框，再用下方文本发送到当前焦点。
                  </div>
                  <div className="flex flex-col gap-3 md:flex-row">
                    <input
                      value={loginControlText}
                      onChange={(e) => setLoginControlText(e.target.value)}
                      onKeyDown={handleLoginTextKeyDown}
                      placeholder="输入到当前焦点"
                      disabled={loginControlBusy}
                      className="flex-1 px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
                    />
                    <button
                      onClick={handleSendLoginText}
                      disabled={loginControlBusy || !loginControlText.trim()}
                      className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium disabled:opacity-50"
                    >
                      发送文本
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {['Enter', 'Tab', 'Backspace', 'Escape'].map((key) => (
                      <button
                        key={key}
                        onClick={() => handleLoginQuickKey(key)}
                        disabled={loginControlBusy}
                        className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-700 disabled:opacity-50"
                      >
                        {key}
                      </button>
                    ))}
                  </div>
                  {loginControlError && <div className="text-sm text-red-600">{loginControlError}</div>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent Screenshot Modal */}
      {screenshotState && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
              <h3 className="text-lg font-bold">当前画面</h3>
              <button
                onClick={() => setScreenshotState(null)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              {screenshotState.loading ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
                  <p className="mt-4 text-gray-500">正在截图...</p>
                </div>
              ) : screenshotState.error ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <p className="text-red-600 font-medium">{screenshotState.error}</p>
                  <button
                    onClick={() => void captureAccountScreenshot(screenshotState.accountId)}
                    className="mt-4 px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg"
                  >
                    重试
                  </button>
                </div>
              ) : screenshotState.image ? (
                <div className="flex flex-col items-center w-full">
                  <div className="relative bg-gray-50 rounded-xl overflow-hidden w-full flex items-center justify-center border border-gray-200 min-h-[300px] md:min-h-[500px]">
                    <img
                      src={`data:image/jpeg;base64,${screenshotState.image}`}
                      alt="Agent Screenshot"
                      className="w-full h-auto object-contain max-h-[70vh] md:max-h-[800px]"
                    />
                  </div>
                  <button
                    onClick={() => void captureAccountScreenshot(screenshotState.accountId)}
                    className="mt-4 px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg"
                  >
                    重新截图
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12">
                  <p className="text-gray-500">无可用截图</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

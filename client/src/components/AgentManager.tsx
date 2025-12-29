import { useState, useEffect, useCallback } from 'react';
import { Copy, Terminal, Settings, RefreshCw, Plus, X } from 'lucide-react';
import { api } from '../services/api';
import { getLoginWsUrl } from '../services/api';
import type { AgentConnection } from '../types';

interface AgentManagerProps {
  agents: AgentConnection[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export default function AgentManager({ agents, isLoading, error, onRefresh }: AgentManagerProps) {
  const LOCAL_AGENT_ID_KEY = 'taobao.localAgentId';
  const AUTO_BIND_KEY = 'taobao.autoBindToLocalAgent';

  // Settings State
  const [localAgentId, setLocalAgentId] = useState<string>(() => {
    try {
      return localStorage.getItem(LOCAL_AGENT_ID_KEY) || '';
    } catch {
      return '';
    }
  });
  const [autoBindToLocalAgent, setAutoBindToLocalAgent] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(AUTO_BIND_KEY);
      if (raw === null) return true;
      return raw === '1';
    } catch {
      return true;
    }
  });

  // Pairing State
  const [showPairModal, setShowPairModal] = useState(false);
  const [pairSetAsDefault, setPairSetAsDefault] = useState(true);
  const [pairLoading, setPairLoading] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairExpiresAtMs, setPairExpiresAtMs] = useState<number | null>(null);
  const [pairNowMs, setPairNowMs] = useState(() => Date.now());

  // Persistence Effects
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_AGENT_ID_KEY, localAgentId);
    } catch {}
  }, [localAgentId]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_BIND_KEY, autoBindToLocalAgent ? '1' : '0');
    } catch {}
  }, [autoBindToLocalAgent]);

  useEffect(() => {
    if (!autoBindToLocalAgent) {
      void api.updateMyPreferredAgent(null).catch(console.error);
      return;
    }
    if (!localAgentId) return;
    void api.updateMyPreferredAgent(localAgentId).catch(console.error);
  }, [autoBindToLocalAgent, localAgentId]);

  useEffect(() => {
    if (localAgentId) return;
    if (agents.length !== 1) return;
    setLocalAgentId(agents[0].agentId);
  }, [agents, localAgentId]);

  // Timer
  useEffect(() => {
    if (!pairExpiresAtMs) return;
    const id = window.setInterval(() => setPairNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [pairExpiresAtMs]);

  const createPairCode = useCallback(async () => {
    setPairLoading(true);
    setPairError(null);
    try {
      const data = await api.createAgentPairCode(pairSetAsDefault);
      setPairCode(data.code);
      setPairExpiresAtMs(Date.now() + data.expiresInSec * 1000);
      setPairNowMs(Date.now());
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Failed to create pair code');
    } finally {
      setPairLoading(false);
    }
  }, [pairSetAsDefault]);

  const copyPairCode = useCallback(async () => {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(pairCode);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = pairCode;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }, [pairCode]);

  const onlineAgentIds = new Set(agents.map((a) => a.agentId));
  const localAgentOnline = !!(localAgentId && onlineAgentIds.has(localAgentId));
  const pairLeftSec = pairExpiresAtMs ? Math.max(0, Math.ceil((pairExpiresAtMs - pairNowMs) / 1000)) : null;
  
  const agentWsHint = (() => {
    try {
      const u = new URL(getLoginWsUrl());
      u.pathname = '/ws/agent';
      u.search = '';
      return u.toString();
    } catch {
      return 'ws://127.0.0.1:4000/ws/agent';
    }
  })();

  const resetPairing = () => {
    setShowPairModal(false);
    setPairCode(null);
    setPairError(null);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
             执行节点 (Agent)
             <span className="text-xs font-normal bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full border border-gray-200">
               {agents.length}
             </span>
          </h3>
        </div>
        
        <div className="flex items-center gap-2">
            {/* Settings Dropdown */}
            <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm">
                <Settings className="w-3.5 h-3.5 text-gray-400" />
                <select
                    className="bg-transparent text-xs text-gray-600 font-medium focus:outline-none min-w-[100px] cursor-pointer"
                    value={localAgentId}
                    onChange={(e) => setLocalAgentId(e.target.value)}
                    disabled={!autoBindToLocalAgent}
                    title="默认执行节点：新账号将自动使用此节点"
                >
                    <option value="">无默认节点</option>
                    {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                        {a.agentId} {localAgentId === a.agentId ? '(默认)' : ''}
                    </option>
                    ))}
                    {!!localAgentId && !localAgentOnline && (
                    <option value={localAgentId}>[离线] {localAgentId}</option>
                    )}
                </select>
                <div className="w-px h-3 bg-gray-200 mx-1"></div>
                <label className="flex items-center gap-1.5 cursor-pointer" title="自动跟随：新账号自动绑定此节点">
                    <input
                        type="checkbox"
                        className="rounded border-gray-300 text-orange-600 focus:ring-orange-500 w-3.5 h-3.5"
                        checked={autoBindToLocalAgent}
                        onChange={(e) => setAutoBindToLocalAgent(e.target.checked)}
                    />
                    <span className="text-xs text-gray-500">自动绑定</span>
                </label>
            </div>

            <button
                onClick={onRefresh}
                disabled={isLoading}
                className="p-1.5 hover:bg-white hover:shadow-sm rounded-lg text-gray-400 hover:text-gray-600 transition-all disabled:opacity-50 border border-transparent hover:border-gray-200"
                title="刷新列表"
            >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-center gap-2">
            <X className="w-4 h-4" />
            {error}
        </div>
      )}

      {/* Grid Layout for Agents */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {agents.map((agent) => (
          <div 
            key={agent.agentId}
            className={`relative group p-4 rounded-xl border shadow-sm transition-all duration-200 ${
              localAgentId === agent.agentId 
                ? 'border-orange-200 bg-orange-50/20 ring-1 ring-orange-100' 
                : 'border-gray-200 bg-white hover:border-orange-300 hover:shadow-md'
            }`}
          >
            <div className="flex items-start justify-between mb-3">
                <div className="p-2 bg-gray-50 rounded-lg border border-gray-100 group-hover:bg-white group-hover:shadow-sm transition-colors">
                    <Terminal className="w-5 h-5 text-gray-600" />
                </div>
                {localAgentId === agent.agentId && (
                    <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-[10px] font-bold rounded-full">
                        默认
                    </span>
                )}
            </div>
            
            <h4 className="font-bold text-gray-900 truncate" title={agent.agentId}>
                {agent.agentId}
            </h4>
            
            <div className="mt-3 flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                    <span className="text-green-600 font-medium">运行中</span>
                </div>
                <span className="text-gray-400" title="Last Seen">
                    {new Date(agent.lastSeenAt).toLocaleTimeString()}
                </span>
            </div>
          </div>
        ))}

        {/* Add New Agent Button */}
        <button
            onClick={() => {
                setShowPairModal(true);
                if (!pairCode) createPairCode();
            }}
            className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50/50 hover:bg-white hover:border-orange-400 hover:shadow-md transition-all duration-200 group min-h-[120px]"
        >
            <div className="w-10 h-10 rounded-full bg-white shadow-sm border border-gray-200 flex items-center justify-center mb-2 group-hover:scale-110 group-hover:border-orange-200 transition-all">
                <Plus className="w-5 h-5 text-gray-400 group-hover:text-orange-500" />
            </div>
            <span className="text-sm font-medium text-gray-500 group-hover:text-orange-600">接入新节点</span>
        </button>
      </div>

      {/* Pairing Modal */}
      {showPairModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
                    <h3 className="font-bold text-gray-900">接入新节点</h3>
                    <button onClick={resetPairing} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                        <X className="w-5 h-5 text-gray-500" />
                    </button>
                </div>
                
                <div className="p-6">
                    <div className="flex flex-col items-center justify-center text-center">
                         <div className="w-16 h-16 bg-orange-50 rounded-full flex items-center justify-center mb-4">
                            <Terminal className="w-8 h-8 text-orange-500" />
                         </div>
                         
                         <p className="text-gray-500 text-sm mb-6 max-w-sm">
                            在另一台电脑上运行 Agent 程序，并使用下方的配对码进行连接。
                         </p>

                         {pairLoading ? (
                            <div className="py-8 flex flex-col items-center">
                                <RefreshCw className="w-8 h-8 text-orange-500 animate-spin mb-2" />
                                <span className="text-sm text-gray-500">生成配对码...</span>
                            </div>
                         ) : (
                            <div className="w-full">
                                {pairCode ? (
                                    <div className="bg-gray-900 rounded-xl p-6 relative group mb-4">
                                        <div className="text-3xl font-mono font-bold text-white tracking-[0.2em] select-all">
                                            {pairCode}
                                        </div>
                                        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-gray-400">
                                            {pairLeftSec !== null && pairLeftSec > 0 ? (
                                                <span className="text-orange-400 flex items-center gap-1">
                                                    <RefreshCw className="w-3 h-3 animate-reverse-spin" /> {pairLeftSec}s 后失效
                                                </span>
                                            ) : (
                                                <span className="text-red-400">已失效</span>
                                            )}
                                        </div>
                                        <button
                                            onClick={() => void copyPairCode()}
                                            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors"
                                            title="复制"
                                        >
                                            <Copy className="w-4 h-4" />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="py-8 text-red-500">{pairError || '生成失败'}</div>
                                )}
                                
                                <div className="bg-gray-50 rounded-xl p-4 text-left border border-gray-200">
                                    <p className="text-xs font-semibold text-gray-500 mb-2">运行命令:</p>
                                    <code className="block font-mono text-xs text-gray-700 break-all select-all bg-white p-2 rounded border border-gray-100">
                                        npm run agent -- --pair {pairCode || '...'} --ws {agentWsHint}
                                    </code>
                                </div>

                                <div className="mt-6 flex items-center justify-center gap-2">
                                    <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                                        <input
                                            type="checkbox"
                                            className="rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                                            checked={pairSetAsDefault}
                                            onChange={(e) => setPairSetAsDefault(e.target.checked)}
                                        />
                                        接入后自动设为默认节点
                                    </label>
                                </div>
                            </div>
                         )}
                    </div>
                </div>

                <div className="p-5 border-t border-gray-100 bg-gray-50/50 flex justify-end">
                    <button
                        onClick={resetPairing}
                        className="px-5 py-2.5 bg-white border border-gray-200 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-colors shadow-sm"
                    >
                        关闭
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, useRef, useCallback } from 'react';
import { Search, Pause, Play, Trash2, Download, Filter } from 'lucide-react';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
}

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  
  const logsEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pausedRef = useRef(isPaused);
  pausedRef.current = isPaused;

  // 自动滚动到底部
  const scrollToBottom = useCallback(() => {
    if (!pausedRef.current && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // 连接 WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_API_URL 
      ? new URL(import.meta.env.VITE_API_URL).host 
      : window.location.host;
    const wsUrl = `${protocol}//${host}/ws/logs`;
    let reconnectTimeout: number | null = null;

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        console.log('[Logs] WebSocket connected');
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message.type === 'history') {
            setLogs(message.logs);
            setTimeout(scrollToBottom, 100);
          } else if (message.type === 'log') {
            setLogs(prev => {
              const newLogs = [...prev, message.log];
              // 保留最近 500 条
              if (newLogs.length > 500) {
                return newLogs.slice(-500);
              }
              return newLogs;
            });
            setTimeout(scrollToBottom, 50);
          }
        } catch (e) {
          console.error('[Logs] Failed to parse message:', e);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        console.log('[Logs] WebSocket disconnected, reconnecting...');
        reconnectTimeout = window.setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        setIsConnected(false);
      };
    };

    connect();

    return () => {
      if (reconnectTimeout !== null) {
        clearTimeout(reconnectTimeout);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [scrollToBottom]);

  // 过滤日志
  const filteredLogs = logs.filter(log => {
    if (filter !== 'all' && log.level !== filter) return false;
    if (search) {
      const query = search.toLowerCase();
      return log.message.toLowerCase().includes(query) || 
             log.source.toLowerCase().includes(query);
    }
    return true;
  });

  // 清空日志
  const handleClear = () => {
    setLogs([]);
  };

  // 导出日志
  const handleExport = () => {
    const content = filteredLogs.map(log => 
      `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`
    ).join('\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return 'text-red-400';
      case 'warn': return 'text-yellow-400';
      case 'info': return 'text-blue-400';
      case 'debug': return 'text-gray-400';
      default: return 'text-gray-300';
    }
  };

  const getLevelBadge = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return 'bg-red-900/50 text-red-300 border-red-700';
      case 'warn': return 'bg-yellow-900/50 text-yellow-300 border-yellow-700';
      case 'info': return 'bg-blue-900/50 text-blue-300 border-blue-700';
      case 'debug': return 'bg-gray-800 text-gray-400 border-gray-600';
      default: return 'bg-gray-800 text-gray-400 border-gray-600';
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false 
    });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">系统日志</h2>
          <p className="text-gray-500 text-sm mt-1 flex items-center gap-2 flex-wrap">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            {isConnected ? '已连接' : '连接中...'} · 共 {filteredLogs.length} 条日志
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`p-2 rounded-lg border transition-colors ${
              isPaused 
                ? 'bg-orange-50 border-orange-200 text-orange-600' 
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
            title={isPaused ? '继续滚动' : '暂停滚动'}
          >
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
          </button>
          <button
            onClick={handleClear}
            className="p-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
            title="清空日志"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleExport}
            className="p-2 bg-white border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
            title="导出日志"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索日志..."
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            <option value="all">全部级别</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>

      {/* Log Console */}
      <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-hidden">
        <div className="h-[400px] sm:h-[600px] overflow-y-auto p-4 font-mono text-xs">
          {filteredLogs.length === 0 ? (
            <div className="text-gray-500 text-center py-20">
              {logs.length === 0 ? '等待日志...' : '没有匹配的日志'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredLogs.map((log) => (
                <div 
                  key={log.id} 
                  className="flex items-start gap-2 hover:bg-gray-800/50 px-2 py-1 rounded group"
                >
                  <span className="text-gray-500 flex-shrink-0">{formatTime(log.timestamp)}</span>
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase flex-shrink-0 ${getLevelBadge(log.level)}`}>
                    {log.level}
                  </span>
                  <span className="text-purple-400 flex-shrink-0">[{log.source}]</span>
                  <span className={`${getLevelColor(log.level)} break-all whitespace-pre-wrap`}>
                    {log.message}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between text-xs text-gray-500 px-2">
        <span>
          {isPaused && <span className="text-orange-500 font-bold">⏸ 已暂停自动滚动</span>}
        </span>
        <span>
          最后更新: {logs.length > 0 ? new Date(logs[logs.length - 1]?.timestamp).toLocaleString('zh-CN') : '-'}
        </span>
      </div>
    </div>
  );
}

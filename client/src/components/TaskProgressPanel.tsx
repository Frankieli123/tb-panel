import { useState, useEffect } from 'react';
import { X, ChevronDown, ChevronUp, Loader2, CheckCircle2, XCircle, Minimize2 } from 'lucide-react';

export interface TaskProgress {
  jobId: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'partial';
  progress: {
    total: number;
    current: number;
    success: number;
    failed: number;
  };
  logs: string[];
  startedAt: number;
  isBatch?: boolean;
  batchItems?: Array<{
    taobaoId?: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }>;
}

interface TaskProgressPanelProps {
  tasks: TaskProgress[];
  onDismiss: (jobId: string) => void;
}

export default function TaskProgressPanel({ tasks, onDismiss }: TaskProgressPanelProps) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  // 自动展开第一个运行中的任务
  useEffect(() => {
    if (!expandedTaskId && tasks.length > 0) {
      const runningTask = tasks.find((t) => t.status === 'running');
      if (runningTask) {
        setExpandedTaskId(runningTask.jobId);
      }
    }
  }, [tasks, expandedTaskId]);

  if (tasks.length === 0) return null;

  const getStatusIcon = (status: TaskProgress['status']) => {
    switch (status) {
      case 'running':
      case 'pending':
        return <Loader2 className="w-4 h-4 animate-spin text-orange-500" />;
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'partial':
        return <CheckCircle2 className="w-4 h-4 text-yellow-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
    }
  };

  const getStatusText = (status: TaskProgress['status']) => {
    switch (status) {
      case 'pending':
        return '等待中';
      case 'running':
        return '执行中';
      case 'completed':
        return '已完成';
      case 'partial':
        return '部分完成';
      case 'failed':
        return '失败';
    }
  };

  const getProgressPercent = (task: TaskProgress) => {
    return task.progress.total > 0
      ? Math.round((task.progress.current / task.progress.total) * 100)
      : 0;
  };

  const formatDuration = (startedAt: number) => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
    const hours = Math.floor(minutes / 60);
    return `${hours}时${minutes % 60}分`;
  };

  return (
    <div className="fixed bottom-4 right-4 z-40 w-96 max-w-[calc(100vw-2rem)]">
      {/* 最小化状态 */}
      {minimized ? (
        <div
          onClick={() => setMinimized(false)}
          className="bg-white rounded-lg shadow-lg border border-gray-200 p-3 flex items-center gap-3 cursor-pointer hover:shadow-xl transition-shadow"
        >
          <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
          <span className="text-sm font-medium text-gray-700">
            {tasks.length} 个任务进行中
          </span>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-2xl border border-gray-200 max-h-[600px] flex flex-col">
          {/* 面板头部 */}
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50 rounded-t-xl">
            <h3 className="font-bold text-gray-900 text-sm">任务进度</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMinimized(true)}
                className="p-1 hover:bg-gray-200 rounded transition-colors"
                title="最小化"
              >
                <Minimize2 className="w-4 h-4 text-gray-500" />
              </button>
            </div>
          </div>

          {/* 任务列表 */}
          <div className="overflow-y-auto max-h-[500px]">
            {tasks.map((task) => {
              const isExpanded = expandedTaskId === task.jobId;
              const progressPercent = getProgressPercent(task);

              return (
                <div
                  key={task.jobId}
                  className="border-b border-gray-100 last:border-0"
                >
                  {/* 任务摘要 */}
                  <div
                    onClick={() => setExpandedTaskId(isExpanded ? null : task.jobId)}
                    className="px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        {getStatusIcon(task.status)}
                        <div className="flex-1 min-w-0">
                          <h4 className="text-sm font-medium text-gray-900 truncate">
                            {task.title}
                          </h4>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {getStatusText(task.status)} · {formatDuration(task.startedAt)}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {(task.status === 'completed' || task.status === 'failed') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDismiss(task.jobId);
                            }}
                            className="p-1 hover:bg-gray-200 rounded transition-colors"
                          >
                            <X className="w-3 h-3 text-gray-400" />
                          </button>
                        )}
                        <button className="p-1">
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-gray-400" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* 进度条 */}
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-gray-200 rounded-full h-1.5 overflow-hidden">
                        <div
                          className={`h-1.5 rounded-full transition-all duration-300 ${
                            task.status === 'failed'
                              ? 'bg-red-500'
                              : task.status === 'completed'
                              ? 'bg-green-500'
                              : 'bg-orange-500'
                          }`}
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500 font-medium min-w-[3rem] text-right">
                        {task.progress.current}/{task.progress.total}
                      </span>
                    </div>

                    {/* 最新日志 - 批量任务只显示简洁进度，非批量任务显示日志 */}
                    {!task.isBatch && task.logs.length > 0 && (
                      <p className="text-xs text-gray-600 mt-2 truncate">
                        {task.logs[task.logs.length - 1]}
                      </p>
                    )}
                    {task.isBatch && task.status === 'running' && (
                      <p className="text-xs text-gray-600 mt-2">
                        正在处理第 {task.progress.current + 1} 个商品...
                      </p>
                    )}
                    {(task.progress.success > 0 || task.progress.failed > 0) && (
                      <div className="flex items-center gap-3 mt-1 text-xs">
                        <span className="text-green-600 font-medium">
                          ✓ 成功: {task.progress.success}
                        </span>
                        {task.progress.failed > 0 && (
                          <span className="text-red-600 font-medium">
                            ✗ 失败: {task.progress.failed}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 展开的详细日志 */}
                  {isExpanded && (
                    <div className="px-4 pb-3">
                      <div className="bg-gray-900 rounded-lg p-3 max-h-48 overflow-y-auto">
                        <div className="space-y-1 text-[11px] font-mono">
                          {task.logs.map((log, i) => (
                            <div key={i} className="text-gray-300">
                              {log}
                            </div>
                          ))}
                        </div>
                      </div>
                      {task.status === 'completed' && (
                        <div className="mt-2 text-xs text-gray-500 flex items-center gap-4">
                          <span className="text-green-600 font-medium">
                            成功: {task.progress.success}
                          </span>
                          {task.progress.failed > 0 && (
                            <span className="text-red-600 font-medium">
                              失败: {task.progress.failed}
                            </span>
                          )}
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
  );
}

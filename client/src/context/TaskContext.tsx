import { createContext, useContext, useState, useRef, useCallback, useEffect, ReactNode } from 'react';
import { api } from '../services/api';

export interface TaskProgress {
  jobId: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'partial';
  cancelling?: boolean;
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

interface TaskContextType {
  tasks: TaskProgress[];
  startTaskMonitoring: (jobId: string, title: string) => void;
  startBatchTaskMonitoring: (batchJobId: string, title: string) => void;
  cancelTask: (jobId: string) => Promise<void>;
  dismissTask: (jobId: string) => void;
}

const TaskContext = createContext<TaskContextType | null>(null);

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const taskIntervalsRef = useRef<Map<string, number>>(new Map());

  const clearTaskTimer = useCallback((jobId: string) => {
    const timerId = taskIntervalsRef.current.get(jobId);
    if (timerId !== undefined) {
      if (timerId > 0) {
        window.clearTimeout(timerId);
      }
      taskIntervalsRef.current.delete(jobId);
    }
  }, []);

  const appendTaskLog = useCallback((jobId: string, text: string) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.jobId !== jobId) return task;
        if (task.logs[task.logs.length - 1] === text) return task;
        return {
          ...task,
          logs: [...task.logs.slice(-199), text],
        };
      })
    );
  }, []);

  useEffect(() => {
    return () => {
      for (const timerId of taskIntervalsRef.current.values()) {
        window.clearTimeout(timerId);
      }
      taskIntervalsRef.current.clear();
    };
  }, []);

  const startTaskMonitoring = useCallback((jobId: string, title: string) => {
    const newTask: TaskProgress = {
      jobId,
      title,
      status: 'pending',
      progress: { total: 0, current: 0, success: 0, failed: 0 },
      logs: ['任务已创建...'],
      startedAt: Date.now(),
    };

    setTasks((prev) => (prev.some((task) => task.jobId === jobId) ? prev : [...prev, newTask]));

    const poll = async (failureCount = 0) => {
      try {
        const status = await api.getAddProgress(jobId);

        setTasks((prev) =>
          prev.map((t) =>
            t.jobId === jobId
              ? {
                  ...t,
                  status: status.status,
                  cancelling: status.status === 'pending' || status.status === 'running' ? t.cancelling : false,
                  progress: status.progress,
                  logs: status.logs,
                }
              : t
          )
        );

        if (status.status === 'completed' || status.status === 'failed') {
          clearTaskTimer(jobId);
          return;
        }
        if (!taskIntervalsRef.current.has(jobId)) return;

        const timerId = window.setTimeout(() => {
          void poll(0);
        }, 2000);
        taskIntervalsRef.current.set(jobId, timerId);
      } catch (error) {
        const nextFailureCount = failureCount + 1;
        console.error('Failed to fetch task progress:', error);
        if (!taskIntervalsRef.current.has(jobId)) return;
        const timerId = window.setTimeout(() => {
          void poll(nextFailureCount);
        }, Math.min(10000, 2000 * nextFailureCount));
        taskIntervalsRef.current.set(jobId, timerId);
      }
    };

    clearTaskTimer(jobId);
    taskIntervalsRef.current.set(jobId, 0);
    void poll(0);
  }, [clearTaskTimer]);

  const startBatchTaskMonitoring = useCallback((batchJobId: string, title: string) => {
    const newTask: TaskProgress = {
      jobId: batchJobId,
      title,
      status: 'running',
      progress: { total: 0, current: 0, success: 0, failed: 0 },
      logs: [],
      startedAt: Date.now(),
      isBatch: true,
    };

    setTasks((prev) => (prev.some((task) => task.jobId === batchJobId) ? prev : [...prev, newTask]));

    const poll = async (failureCount = 0) => {
      try {
        const status = await api.getBatchAddProgress(batchJobId);

        const aggregatedLogs = status.items
          .flatMap((item, orderIndex) =>
            item.logs.map((line) => {
              const prefix = `[${orderIndex + 1}/${status.items.length}]`;
              const id = item.taobaoId ? ` [${item.taobaoId}]` : '';
              return `${prefix}${id} ${line}`;
            })
          )
          .slice(-200);

        setTasks((prev) =>
          prev.map((t) =>
            t.jobId === batchJobId
              ? {
                  ...t,
                  status: status.status,
                  cancelling: status.status === 'pending' || status.status === 'running' ? t.cancelling : false,
                  progress: {
                    total: status.progress.totalItems,
                    current: status.progress.completedItems,
                    success: status.progress.successItems,
                    failed: status.progress.failedItems,
                  },
                  logs: aggregatedLogs,
                  isBatch: true,
                  batchItems: status.items.map((item) => ({
                    taobaoId: item.taobaoId,
                    status: item.status,
                  })),
                }
              : t
          )
        );

        if (status.status === 'completed' || status.status === 'failed' || status.status === 'partial') {
          clearTaskTimer(batchJobId);
          return;
        }
        if (!taskIntervalsRef.current.has(batchJobId)) return;

        const timerId = window.setTimeout(() => {
          void poll(0);
        }, 3000);
        taskIntervalsRef.current.set(batchJobId, timerId);
      } catch (error) {
        const nextFailureCount = failureCount + 1;
        console.error('Failed to fetch batch task progress:', error);
        if (!taskIntervalsRef.current.has(batchJobId)) return;
        const timerId = window.setTimeout(() => {
          void poll(nextFailureCount);
        }, Math.min(15000, 3000 * nextFailureCount));
        taskIntervalsRef.current.set(batchJobId, timerId);
      }
    };

    clearTaskTimer(batchJobId);
    taskIntervalsRef.current.set(batchJobId, 0);
    void poll(0);
  }, [clearTaskTimer]);

  const cancelTask = useCallback(
    async (jobId: string) => {
      setTasks((prev) =>
        prev.map((task) =>
          task.jobId === jobId
            ? {
                ...task,
                cancelling: true,
              }
            : task
        )
      );
      appendTaskLog(jobId, '正在发送取消请求...');

      try {
        const result = await api.cancelAddTask(jobId);

        if (result.cancelled) {
          clearTaskTimer(jobId);
          setTasks((prev) =>
            prev.map((task) =>
              task.jobId === jobId
                ? {
                    ...task,
                    status: 'failed',
                    cancelling: false,
                    logs: [...task.logs.slice(-199), '任务已取消'],
                  }
                : task
            )
          );
          return;
        }

        if (result.cancelRequested) {
          appendTaskLog(jobId, '取消请求已发送，等待任务停止...');
          return;
        }

        setTasks((prev) =>
          prev.map((task) =>
            task.jobId === jobId
              ? {
                  ...task,
                  cancelling: false,
                }
              : task
          )
        );
        appendTaskLog(jobId, result.finished ? '任务已结束，无法取消' : '当前任务无法取消');
      } catch (error) {
        setTasks((prev) =>
          prev.map((task) =>
            task.jobId === jobId
              ? {
                  ...task,
                  cancelling: false,
                }
              : task
          )
        );
        appendTaskLog(jobId, error instanceof Error ? error.message : '取消任务失败');
      }
    },
    [appendTaskLog, clearTaskTimer]
  );

  const dismissTask = useCallback((jobId: string) => {
    clearTaskTimer(jobId);
    setTasks((prev) => prev.filter((t) => t.jobId !== jobId));
  }, [clearTaskTimer]);

  return (
    <TaskContext.Provider value={{ tasks, startTaskMonitoring, startBatchTaskMonitoring, cancelTask, dismissTask }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTask() {
  const context = useContext(TaskContext);
  if (!context) {
    throw new Error('useTask must be used within a TaskProvider');
  }
  return context;
}

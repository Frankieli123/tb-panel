import { createContext, useContext, useState, useRef, useCallback, ReactNode } from 'react';
import { api } from '../services/api';

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

interface TaskContextType {
  tasks: TaskProgress[];
  startTaskMonitoring: (jobId: string, title: string) => void;
  startBatchTaskMonitoring: (batchJobId: string, title: string) => void;
  dismissTask: (jobId: string) => void;
}

const TaskContext = createContext<TaskContextType | null>(null);

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const taskIntervalsRef = useRef<Map<string, number>>(new Map());

  const startTaskMonitoring = useCallback((jobId: string, title: string) => {
    const newTask: TaskProgress = {
      jobId,
      title,
      status: 'pending',
      progress: { total: 0, current: 0, success: 0, failed: 0 },
      logs: ['任务已创建...'],
      startedAt: Date.now(),
    };

    setTasks((prev) => [...prev, newTask]);

    const intervalId = window.setInterval(async () => {
      try {
        const status = await api.getAddProgress(jobId);

        setTasks((prev) =>
          prev.map((t) =>
            t.jobId === jobId
              ? {
                  ...t,
                  status: status.status,
                  progress: status.progress,
                  logs: status.logs,
                }
              : t
          )
        );

        if (status.status === 'completed' || status.status === 'failed') {
          const interval = taskIntervalsRef.current.get(jobId);
          if (interval) {
            clearInterval(interval);
            taskIntervalsRef.current.delete(jobId);
          }
        }
      } catch (error) {
        console.error('Failed to fetch task progress:', error);
      }
    }, 1000);

    taskIntervalsRef.current.set(jobId, intervalId);
  }, []);

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

    setTasks((prev) => [...prev, newTask]);

    const intervalId = window.setInterval(async () => {
      try {
        const status = await api.getBatchAddProgress(batchJobId);

        setTasks((prev) =>
          prev.map((t) =>
            t.jobId === batchJobId
              ? {
                  ...t,
                  status: status.status,
                  progress: {
                    total: status.progress.totalItems,
                    current: status.progress.completedItems,
                    success: status.progress.successItems,
                    failed: status.progress.failedItems,
                  },
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
          const interval = taskIntervalsRef.current.get(batchJobId);
          if (interval) {
            clearInterval(interval);
            taskIntervalsRef.current.delete(batchJobId);
          }
        }
      } catch (error) {
        console.error('Failed to fetch batch task progress:', error);
      }
    }, 2000);

    taskIntervalsRef.current.set(batchJobId, intervalId);
  }, []);

  const dismissTask = useCallback((jobId: string) => {
    const intervalId = taskIntervalsRef.current.get(jobId);
    if (intervalId) {
      clearInterval(intervalId);
      taskIntervalsRef.current.delete(jobId);
    }
    setTasks((prev) => prev.filter((t) => t.jobId !== jobId));
  }, []);

  return (
    <TaskContext.Provider value={{ tasks, startTaskMonitoring, startBatchTaskMonitoring, dismissTask }}>
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

import { useEffect, useRef, useCallback } from 'react';

export interface ProductUpdateMessage {
  type: 'product_update';
  productId: string;
  data: {
    lastCheckAt: string;
    currentPrice?: number | null;
    title?: string | null;
  };
  timestamp: number;
}

export interface TaskUpdateMessage {
  type: 'task_update';
  jobId: string;
  status: string;
  progress?: any;
  timestamp: number;
}

export interface SystemUpdateMessage {
  type: 'system_update';
  timestamp: number;
}

export type PushMessage = ProductUpdateMessage | TaskUpdateMessage | SystemUpdateMessage | { type: 'connected'; timestamp: number };

interface UseRealtimeUpdatesOptions {
  onProductUpdate?: (productId: string, data: ProductUpdateMessage['data']) => void;
  onTaskUpdate?: (jobId: string, status: string, progress?: any) => void;
  onSystemUpdate?: () => void;
}

export function useRealtimeUpdates(options: UseRealtimeUpdatesOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connect = useCallback(() => {
    // 构建 WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_API_URL 
      ? new URL(import.meta.env.VITE_API_URL).host 
      : window.location.host;
    const wsUrl = `${protocol}//${host}/ws/updates`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WebSocket] Connected to realtime updates');
      };

      ws.onmessage = (event) => {
        try {
          const message: PushMessage = JSON.parse(event.data);
          
          if (message.type === 'product_update') {
            optionsRef.current.onProductUpdate?.(message.productId, message.data);
          } else if (message.type === 'task_update') {
            optionsRef.current.onTaskUpdate?.(message.jobId, message.status, message.progress);
          } else if (message.type === 'system_update') {
            optionsRef.current.onSystemUpdate?.();
          }
        } catch (e) {
          console.error('[WebSocket] Failed to parse message:', e);
        }
      };

      ws.onclose = () => {
        console.log('[WebSocket] Disconnected, reconnecting in 3s...');
        wsRef.current = null;
        reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
      };
    } catch (e) {
      console.error('[WebSocket] Failed to connect:', e);
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);
}

import { useState, useEffect, useCallback, useRef } from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/ws';

interface WebSocketMessage {
  type: string;
  data: ActivityMessage;
}

export interface ActivityMessage {
  event: string;
  agent: string;
  agent_name?: string;
  hive?: string;
  forge?: string;
  title?: string;
  timestamp: string;
  target_id?: string;
}

interface UseWebSocketReturn {
  isConnected: boolean;
  messages: ActivityMessage[];
  isPaused: boolean;
  togglePause: () => void;
  clearMessages: () => void;
  reconnect: () => void;
}

export function useWebSocket(): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [messages, setMessages] = useState<ActivityMessage[]>([]);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef<number>(0);

  const connect = useCallback((): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      wsRef.current = new WebSocket(WS_URL);

      wsRef.current.onopen = (): void => {
        setIsConnected(true);
        reconnectAttempts.current = 0;
      };

      wsRef.current.onmessage = (event: MessageEvent): void => {
        if (isPaused) return;

        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          if (message.type === 'activity') {
            setMessages((prev) => [message.data, ...prev].slice(0, 100));
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      wsRef.current.onclose = (): void => {
        setIsConnected(false);

        // Exponential backoff reconnection
        const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000);
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectAttempts.current++;
          connect();
        }, delay);
      };

      wsRef.current.onerror = (error: Event): void => {
        console.error('WebSocket error:', error);
      };
    } catch (err) {
      console.error('Failed to connect WebSocket:', err);
    }
  }, [isPaused]);

  const disconnect = useCallback((): void => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const togglePause = useCallback((): void => {
    setIsPaused((prev) => !prev);
  }, []);

  const clearMessages = useCallback((): void => {
    setMessages([]);
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    isConnected,
    messages,
    isPaused,
    togglePause,
    clearMessages,
    reconnect: connect,
  };
}

export default useWebSocket;

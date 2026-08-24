import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from './AuthContext.jsx';
import { api } from '../api/endpoints.js';

const WebSocketContext = createContext(null);

export const WebSocketProvider = ({ children }) => {
  const { isAuthenticated, token } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const [eventHistory, setEventHistory] = useState([]);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const isUnmountedRef = useRef(false);

  // Load existing persistent system events on mount / auth
  useEffect(() => {
    if (!isAuthenticated) return;
    let isCancelled = false;
    const loadInitialEvents = async () => {
      try {
        const res = await api.metrics.getEvents(100);
        if (!isCancelled && Array.isArray(res?.data)) {
          setEventHistory(res.data);
        }
      } catch (e) {}
    };
    loadInitialEvents();
    return () => { isCancelled = true; };
  }, [isAuthenticated]);

  const clearTimers = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback((currentToken) => {
    if (isUnmountedRef.current || !currentToken) return;

    // Close any existing connection first
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch (e) {}
    }

    try {
      // Use Vite proxy: ws on same host/port, proxied to backend:4000/ws
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(currentToken)}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const connectionTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          try { ws.close(); } catch (e) {}
        }
      }, 8000);

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        if (isUnmountedRef.current) { try { ws.close(); } catch (e) {} return; }
        setIsConnected(true);
        reconnectAttemptsRef.current = 0; // Reset backoff on success

        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'PING' })); } catch (e) {}
          }
        }, 20000);
      };

      ws.onmessage = (event) => {
        if (isUnmountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'PONG' || data.type === 'CONNECTED') return;
          setLastEvent(data);
          setEventHistory((prev) => [...prev.slice(-149), data]);
        } catch (e) {}
      };

      ws.onclose = () => {
        clearTimeout(connectionTimeout);
        if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
        if (isUnmountedRef.current) return;

        setIsConnected(false);

        // Exponential backoff: 1s, 2s, 4s, 8s, capped at 8s
        const attempts = reconnectAttemptsRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempts), 8000);
        reconnectAttemptsRef.current = attempts + 1;

        reconnectTimerRef.current = setTimeout(() => {
          if (!isUnmountedRef.current) {
            connect(localStorage.getItem('djs_token') || currentToken);
          }
        }, delay);
      };

      ws.onerror = () => {
        // Let onclose handle reconnect — don't double-trigger
        clearTimeout(connectionTimeout);
      };
    } catch (e) {
      if (!isUnmountedRef.current) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 8000);
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(() => connect(currentToken), delay);
      }
    }
  }, []);

  useEffect(() => {
    isUnmountedRef.current = false;
    const currentToken = token || localStorage.getItem('djs_token');

    if (!isAuthenticated || !currentToken) {
      setIsConnected(false);
      clearTimers();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch (e) {}
        wsRef.current = null;
      }
      return;
    }

    connect(currentToken);

    return () => {
      isUnmountedRef.current = true;
      clearTimers();
      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        try { ws.close(); } catch (e) {}
      }
    };
  }, [isAuthenticated, token, connect, clearTimers]);

  return (
    <WebSocketContext.Provider value={{ isConnected, lastEvent, eventHistory }}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocket = () => useContext(WebSocketContext);

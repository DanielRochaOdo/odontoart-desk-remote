const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? "ws://localhost:8080";

export type WsMessage = {
  type: string;
  payload?: any;
};

export type SignalingStatus = "connecting" | "open" | "reconnecting" | "closed";

export type SignalingHandlers = {
  onMessage: (message: WsMessage) => void;
  onClose?: (info?: { code?: number; reason?: string }) => void;
  onOpen?: () => void;
  onStatus?: (status: SignalingStatus) => void;
};

export const connectSignaling = (token: string, handlers: SignalingHandlers) => {
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  const queue: WsMessage[] = [];
  const maxQueue = 50;
  const baseDelayMs = 500;
  const maxDelayMs = 10_000;
  const terminalCodes = new Set([1000, 1008, 4000, 4001]);

  const scheduleReconnect = () => {
    if (closedByUser) return;
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** reconnectAttempts) + jitter;
    reconnectAttempts += 1;
    handlers.onStatus?.("reconnecting");
    reconnectTimer = window.setTimeout(connect, delay);
  };

  const flushQueue = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.length) {
      const message = queue.shift();
      if (!message) continue;
      ws.send(JSON.stringify(message));
    }
  };

  const connect = () => {
    handlers.onStatus?.(reconnectAttempts ? "reconnecting" : "connecting");
    ws = new WebSocket(`${SIGNALING_URL}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      reconnectAttempts = 0;
      handlers.onStatus?.("open");
      handlers.onOpen?.();
      flushQueue();
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handlers.onMessage(message);
      } catch {
        // ignore
      }
    };
    ws.onerror = () => {
      // wait for onclose to reconnect
    };
    ws.onclose = (event) => {
      const code = event.code;
      const reason = event.reason;
      ws = null;
      if (closedByUser || terminalCodes.has(code)) {
        handlers.onStatus?.("closed");
        handlers.onClose?.({ code, reason });
        return;
      }
      scheduleReconnect();
    };
  };

  connect();

  return {
    send: (message: WsMessage) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        return;
      }
      queue.push(message);
      if (queue.length > maxQueue) queue.shift();
    },
    close: () => {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close(1000, "closed_by_user");
    }
  };
};

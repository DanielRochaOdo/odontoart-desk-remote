import type http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { sessionStore } from "./sessions.js";
import { verifyToken } from "./auth.js";
import type { JwtPayload, WsMessage } from "./types.js";

const allowedForwardTypes = new Set([
  "request_share",
  "share_accepted",
  "share_declined",
  "offer",
  "answer",
  "ice",
  "request_control",
  "control_granted",
  "control_denied",
  "request_file_transfer",
  "file_transfer_accepted",
  "file_transfer_denied",
  "screen_info",
  "session_end"
]);

const sendSafe = (socket: WebSocket | undefined, message: WsMessage) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
};

const isOpen = (socket: WebSocket | undefined) => socket?.readyState === WebSocket.OPEN;

const otherSocket = (payload: JwtPayload) => {
  const session = sessionStore.getById(payload.sessionId ?? "");
  if (!session) return undefined;
  if (payload.role === "agent") return session.controllerSocket;
  return session.agentSocket;
};

const flushPendingToAgent = (sessionId: string) => {
  const session = sessionStore.getById(sessionId);
  if (!session || !isOpen(session.agentSocket)) return;
  const pending = session.pendingRequests;
  const entries = Object.entries(pending);
  if (!entries.length) return;
  for (const [, message] of entries) {
    if (message) {
      sendSafe(session.agentSocket, message);
    }
  }
  session.pendingRequests = {};
  logger.info({ msg: "ws_pending_flushed", sessionId, count: entries.length });
};

const sendPeerStatusToSocket = (
  sessionId: string,
  socket: WebSocket | undefined,
  peerRole: "agent" | "controller",
  peerOnline: boolean
) => {
  sendSafe(socket, {
    type: "peer_status",
    payload: { online: peerOnline, role: peerRole }
  });
};

const attachSocket = (payload: JwtPayload, socket: WebSocket) => {
  const session = sessionStore.getById(payload.sessionId ?? "");
  if (!session) return false;
  if (payload.role === "agent") {
    if (session.agentSocket && session.agentSocket !== socket) {
      session.agentSocket.close(4001, "replaced");
    }
    session.agentSocket = socket;
  } else {
    if (session.controllerSocket && session.controllerSocket !== socket) {
      session.controllerSocket.close(4001, "replaced");
    }
    session.controllerSocket = socket;
  }
  return true;
};

export const setupWebSocket = (server: http.Server) => {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) {
      logger.warn({ msg: "ws_rejected", reason: "missing_token" });
      socket.close(1008, "missing token");
      return;
    }

    let payload: JwtPayload;
    try {
      payload = verifyToken(token);
      if (!payload.sessionId) throw new Error("missing sessionId");
    } catch (err) {
      logger.warn({ msg: "ws_rejected", reason: "invalid_token" });
      socket.close(1008, "invalid token");
      return;
    }

    if (payload.role !== "agent" && payload.role !== "controller") {
      logger.warn({ msg: "ws_rejected", reason: "invalid_role", role: payload.role });
      socket.close(1008, "invalid role");
      return;
    }

    const session = sessionStore.getById(payload.sessionId);
    if (!session) {
      logger.warn({ msg: "ws_rejected", reason: "unknown_session", sessionId: payload.sessionId });
      socket.close(1008, "unknown session");
      return;
    }

    if (!attachSocket(payload, socket)) {
      socket.close(1011, "session attach failed");
      return;
    }

    logger.info({ msg: "ws_connected", role: payload.role, sessionId: session.sessionId });

    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    socket.on("pong", () => {
      (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    sendSafe(otherSocket(payload), {
      type: "peer_joined",
      payload: { role: payload.role, userId: payload.sub }
    });
    const otherSocketForStatus = payload.role === "agent" ? session.controllerSocket : session.agentSocket;
    sendPeerStatusToSocket(
      session.sessionId,
      payload.role === "agent" ? session.agentSocket : session.controllerSocket,
      payload.role === "agent" ? "controller" : "agent",
      Boolean(isOpen(otherSocketForStatus))
    );
    if (payload.role === "agent") {
      flushPendingToAgent(session.sessionId);
    }

    let messageCount = 0;
    const rateInterval = setInterval(() => {
      messageCount = 0;
    }, 1000);

    const heartbeat = setInterval(() => {
      const stateful = socket as WebSocket & { isAlive?: boolean };
      if (socket.readyState !== socket.OPEN) return;
      if (stateful.isAlive === false) {
        logger.warn({ msg: "ws_terminated", role: payload.role, sessionId: session.sessionId });
        socket.terminate();
        return;
      }
      stateful.isAlive = false;
      socket.ping();
    }, config.WS_HEARTBEAT_SEC * 1000);

    socket.on("message", (raw) => {
      messageCount += 1;
      if (messageCount > 50) {
        socket.close(1011, "rate limit");
        return;
      }

      let message: WsMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!message?.type || typeof message.type !== "string") return;
      if (!allowedForwardTypes.has(message.type)) return;

      if (message.type === "share_accepted") {
        session.audit.viewGranted = true;
      }
      if (message.type === "control_granted") {
        session.audit.controlGranted = true;
      }
      const peerSocket = otherSocket(payload);
      if (message.type === "session_end") {
        sendSafe(peerSocket, message);
        sessionStore.remove(session.sessionId);
        return;
      }

      if (!isOpen(peerSocket)) {
        if (message.type === "request_share" || message.type === "request_control" || message.type === "request_file_transfer") {
          session.pendingRequests[message.type] = message;
          logger.info({
            msg: "ws_buffered",
            sessionId: session.sessionId,
            type: message.type,
            from: payload.role
          });
        }
        return;
      }

      if (message.type === "request_share") {
        logger.info({ msg: "ws_request_share", sessionId: session.sessionId, from: payload.role });
      }

      sendSafe(peerSocket, message);
    });

    socket.on("close", () => {
      clearInterval(rateInterval);
      clearInterval(heartbeat);
      if (payload.role === "agent") {
        session.agentSocket = undefined;
      } else {
        session.controllerSocket = undefined;
      }
      sendSafe(otherSocket(payload), {
        type: "peer_left",
        payload: { role: payload.role }
      });
      sendPeerStatusToSocket(
        session.sessionId,
        otherSocket(payload),
        payload.role,
        false
      );
      logger.info({ msg: "ws_disconnected", role: payload.role, sessionId: session.sessionId });
    });
  });

  return wss;
};

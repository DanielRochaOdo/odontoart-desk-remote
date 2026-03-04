import type { WebSocket } from "ws";

export type TokenRole = "agent" | "controller" | "technician";

export interface JwtPayload {
  sub: string;
  role: TokenRole;
  sessionId?: string;
  agentId?: string;
}

export interface Session {
  sessionId: string;
  agentId: string;
  agentName?: string;
  code: string;
  createdAt: number;
  codeExpiresAt: number;
  controllerUserId?: string;
  agentSocket?: WebSocket;
  controllerSocket?: WebSocket;
  audit: {
    viewGranted: boolean;
    controlGranted: boolean;
  };
  pendingRequests: Partial<
    Record<"request_share" | "request_control" | "request_file_transfer", WsMessage>
  >;
  createdByIp: string;
}

export interface WsMessage<T = unknown> {
  type: string;
  payload?: T;
}

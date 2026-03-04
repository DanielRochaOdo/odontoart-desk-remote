import { randomInt, randomUUID } from "crypto";
import { config } from "./config.js";
import type { Session } from "./types.js";

const codeDigits = "0123456789";

const generateCode = (length = 6) => {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += codeDigits[randomInt(0, codeDigits.length)];
  }
  return out;
};

export class SessionStore {
  private sessionsByAgent = new Map<string, Session>();
  private sessionsById = new Map<string, Session>();

  createSession(
    agentId: string,
    agentName: string | undefined,
    createdByIp: string,
    preferredCode?: string
  ) {
    const sessionId = randomUUID();
    const code = preferredCode ?? generateCode(6);
    const now = Date.now();
    const codeExpiresAt = now + config.SESSION_CODE_TTL_MIN * 60_000;

    const session: Session = {
      sessionId,
      agentId,
      agentName,
      code,
      createdAt: now,
      codeExpiresAt,
      audit: { viewGranted: false, controlGranted: false },
      pendingRequests: {},
      createdByIp
    };

    const previous = this.sessionsByAgent.get(agentId);
    if (previous) {
      previous.agentSocket?.close(4000, "session_replaced");
      previous.controllerSocket?.close(4000, "session_replaced");
      this.sessionsById.delete(previous.sessionId);
    }

    this.sessionsByAgent.set(agentId, session);
    this.sessionsById.set(sessionId, session);
    return session;
  }

  getByAgent(agentId: string) {
    return this.sessionsByAgent.get(agentId);
  }

  getById(sessionId: string) {
    return this.sessionsById.get(sessionId);
  }

  joinSession(agentId: string, code: string) {
    const session = this.sessionsByAgent.get(agentId);
    if (!session) return { ok: false as const, reason: "not_found" };
    if (session.code !== code) return { ok: false as const, reason: "invalid_code" };
    if (Date.now() > session.codeExpiresAt && !session.agentSocket) {
      return { ok: false as const, reason: "expired" };
    }
    return { ok: true as const, session };
  }

  list() {
    return Array.from(this.sessionsById.values());
  }

  remove(sessionId: string) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    session.agentSocket?.close(4000, "session_ended");
    session.controllerSocket?.close(4000, "session_ended");
    this.sessionsById.delete(sessionId);
    this.sessionsByAgent.delete(session.agentId);
  }

  cleanupExpired() {
    const now = Date.now();
    for (const session of this.sessionsById.values()) {
      if (now > session.codeExpiresAt && !session.agentSocket && !session.controllerSocket) {
        this.remove(session.sessionId);
      }
    }
  }
}

export const sessionStore = new SessionStore();

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

export interface CreateSessionResponse {
  agentId: string;
  sessionId: string;
  code: string;
  codeExpiresAt: number;
  token: string;
}

export async function createSession(
  agentId: string,
  agentName?: string,
  code?: string
): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_URL}/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, agentName, code })
  });
  if (!res.ok) {
    throw new Error(`session_create_failed:${res.status}`);
  }
  return res.json();
}

export async function endSession(sessionId: string, token?: string) {
  const res = await fetch(`${API_URL}/sessions/end`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ sessionId })
  });
  if (!res.ok) {
    throw new Error(`session_end_failed:${res.status}`);
  }
  return res.json();
}

export async function sendAudit(token: string, sessionId: string, events: unknown[]) {
  const res = await fetch(`${API_URL}/audit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ sessionId, events })
  });
  if (!res.ok) {
    throw new Error(`audit_failed:${res.status}`);
  }
  return res.json();
}

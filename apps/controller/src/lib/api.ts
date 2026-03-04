const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

export interface LoginResponse {
  access_token: string;
  expires_in_min: number;
  user: { id: string; email: string };
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    throw new Error(`login_failed:${res.status}`);
  }
  return res.json();
}

export async function listSessions(token: string) {
  const res = await fetch(`${API_URL}/sessions`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`sessions_failed:${res.status}`);
  return res.json();
}

export async function joinSession(agentId: string, code: string, token: string) {
  const res = await fetch(`${API_URL}/sessions/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ agentId, code })
  });
  if (!res.ok) {
    let reason = `status_${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) {
        reason = body.error;
      }
    } catch {
      // ignore
    }
    throw new Error(`join_failed:${reason}`);
  }
  return res.json();
}

export async function endSession(sessionId: string, token: string) {
  const res = await fetch(`${API_URL}/sessions/end`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ sessionId })
  });
  if (!res.ok) throw new Error(`end_failed:${res.status}`);
  return res.json();
}

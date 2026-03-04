import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { hashPassword, issueToken, passwordMatches, requireAnyAuth, requireAuth } from "./auth.js";
import { sessionStore } from "./sessions.js";
import { setupWebSocket } from "./ws.js";
import { randomUUID } from "crypto";

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));

process.on("unhandledRejection", (reason) => {
  logger.error({ msg: "unhandled_rejection", reason });
});

process.on("uncaughtException", (err) => {
  logger.error({ msg: "uncaught_exception", err });
});

const generalLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_SEC * 1000,
  limit: config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});

const loginLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_SEC * 1000,
  limit: config.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);

const techUser = {
  id: "tech-1",
  email: config.TECH_EMAIL,
  passwordHash: await hashPassword(config.TECH_PASSWORD)
};

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.post("/auth/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "missing_credentials" });
  }
  if (email !== techUser.email) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const valid = await passwordMatches(password, techUser.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "invalid_credentials" });
  }

  const token = issueToken({ sub: techUser.id, role: "technician" }, config.CONTROLLER_TOKEN_TTL_MIN);
  return res.json({ access_token: token, expires_in_min: config.CONTROLLER_TOKEN_TTL_MIN, user: { id: techUser.id, email: techUser.email } });
});

app.get("/sessions", requireAuth(["technician"]), (_req, res) => {
  const sessions = sessionStore.list().map((session) => ({
    sessionId: session.sessionId,
    agentId: session.agentId,
    agentName: session.agentName ?? null,
    code: session.code,
    codeExpiresAt: session.codeExpiresAt,
    createdAt: session.createdAt,
    controllerUserId: session.controllerUserId ?? null,
    audit: session.audit
  }));
  return res.json({ sessions });
});

app.post("/sessions/create", (req, res) => {
  const { agentId, agentName, code } = req.body ?? {};
  if (!agentId || typeof agentId !== "string" || agentId.length < 6) {
    return res.status(400).json({ error: "invalid_agent_id" });
  }
  let preferredCode: string | undefined;
  if (code !== undefined) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "invalid_code_format" });
    }
    preferredCode = code;
  }
  const safeName =
    typeof agentName === "string" && agentName.trim().length > 0
      ? agentName.trim().slice(0, 80)
      : undefined;
  const session = sessionStore.createSession(agentId, safeName, req.ip, preferredCode);
  const agentToken = issueToken(
    { sub: agentId, role: "agent", sessionId: session.sessionId, agentId },
    config.SESSION_TOKEN_TTL_MIN
  );

  logger.info({
    msg: "session_created",
    sessionId: session.sessionId,
    agentId,
    agentName: session.agentName ?? null,
    ip: req.ip
  });

  return res.json({
    agentId: session.agentId,
    sessionId: session.sessionId,
    code: session.code,
    codeExpiresAt: session.codeExpiresAt,
    token: agentToken
  });
});

app.post("/sessions/join", requireAuth(["technician"]), (req, res) => {
  const { agentId, code } = req.body ?? {};
  if (!agentId || !code) {
    return res.status(400).json({ error: "missing_agent_or_code" });
  }
  const joined = sessionStore.joinSession(agentId, code);
  if (!joined.ok) {
    return res.status(400).json({ error: joined.reason });
  }
  const session = joined.session;
  session.controllerUserId = (req as any).auth?.sub ?? "unknown";
  const controllerToken = issueToken(
    { sub: session.controllerUserId, role: "controller", sessionId: session.sessionId, agentId },
    config.CONTROLLER_TOKEN_TTL_MIN
  );
  logger.info({
    msg: "session_joined",
    sessionId: session.sessionId,
    agentId,
    controllerUserId: session.controllerUserId,
    ip: req.ip
  });
  return res.json({
    sessionId: session.sessionId,
    agentId: session.agentId,
    codeExpiresAt: session.codeExpiresAt,
    token: controllerToken
  });
});

app.post("/sessions/end", requireAnyAuth(), (req, res) => {
  const { sessionId } = req.body ?? {};
  if (!sessionId) return res.status(400).json({ error: "missing_session_id" });
  sessionStore.remove(sessionId);
  return res.json({ ok: true });
});

app.post("/audit", requireAnyAuth(), (req, res) => {
  const { sessionId, events } = req.body ?? {};
  if (!sessionId || !Array.isArray(events)) {
    return res.status(400).json({ error: "invalid_payload" });
  }
  logger.info({
    msg: "audit_log",
    sessionId,
    ip: req.ip,
    actor: (req as any).auth?.sub,
    events
  });
  return res.json({ ok: true, id: randomUUID() });
});

const server = http.createServer(app);
setupWebSocket(server);

setInterval(() => sessionStore.cleanupExpired(), 30_000);

server.listen(config.PORT, () => {
  logger.info({ msg: "server_listening", port: config.PORT });
});

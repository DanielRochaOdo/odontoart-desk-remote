import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { login, listSessions, joinSession, endSession } from "./lib/api";
import { connectSignaling, type WsMessage } from "./lib/signaling";
import { createPeerConnection } from "./lib/webrtc";

interface AuthState {
  token: string;
  user: { id: string; email: string };
}

interface SessionSummary {
  sessionId: string;
  agentId: string;
  agentName?: string | null;
  code?: string | null;
  codeExpiresAt: number;
  createdAt: number;
  controllerUserId?: string | null;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [code, setCode] = useState("");
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("Desconectado");
  const [connection, setConnection] = useState<ReturnType<typeof connectSignaling> | null>(null);
  const [peer, setPeer] = useState<RTCPeerConnection | null>(null);
  const [controlAllowed, setControlAllowed] = useState(false);
  const [remoteScreen, setRemoteScreen] = useState<{ width: number; height: number } | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [fileTransferAllowed, setFileTransferAllowed] = useState(false);
  const [accessFlowRequested, setAccessFlowRequested] = useState(false);
  const [peerOnline, setPeerOnline] = useState(false);
  const [viewMode, setViewMode] = useState<"dashboard" | "viewer">("dashboard");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const authRef = useRef<AuthState | null>(null);
  const accessFlowRequestedRef = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem("auth");
    if (stored) {
      const parsed = JSON.parse(stored);
      setAuth(parsed);
    }
  }, []);

  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  useEffect(() => {
    accessFlowRequestedRef.current = accessFlowRequested;
  }, [accessFlowRequested]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = remoteStream;
      videoRef.current.muted = true;
      if (remoteStream) {
        void videoRef.current.play().catch(() => {});
      }
    }
  }, [remoteStream, viewMode]);

  const refreshSessions = useCallback(async () => {
    if (!auth) return;
    try {
      const data = await listSessions(auth.token);
      setSessions(data.sessions ?? []);
    } catch {
      // ignore
    }
  }, [auth]);

  useEffect(() => {
    if (auth) {
      refreshSessions();
    }
  }, [auth, refreshSessions]);

  const handleLogin = async () => {
    try {
      const trimmedEmail = email.trim();
      const trimmedPassword = password.trim();
      if (!trimmedEmail || !trimmedPassword) {
        setStatus("Informe email e senha");
        return;
      }
      setStatus("Autenticando...");
      const response = await login(trimmedEmail, trimmedPassword);
      const nextAuth = { token: response.access_token, user: response.user };
      setAuth(nextAuth);
      localStorage.setItem("auth", JSON.stringify(nextAuth));
      setStatus("Autenticado");
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes("login_failed:401")) {
          setStatus("Credenciais invalidas");
          return;
        }
        if (err.message.includes("login_failed:429")) {
          setStatus("Muitas tentativas. Aguarde alguns segundos.");
          return;
        }
        if (err.message.includes("login_failed:")) {
          setStatus("Falha no login (servidor rejeitou)");
          return;
        }
        if (err.message.toLowerCase().includes("failed to fetch")) {
          setStatus("Servidor indisponivel");
          return;
        }
      }
      setStatus("Falha no login");
    }
  };

  const handleLogout = () => {
    setAuth(null);
    localStorage.removeItem("auth");
    setSessions([]);
    setViewMode("dashboard");
  };

  const cleanupSession = useCallback(
    async (notifyRemote: boolean) => {
      if (notifyRemote) {
        connection?.send({ type: "session_end", payload: { reason: "ended_by_controller" } });
      }

      dataChannelRef.current?.close();
      dataChannelRef.current = null;
      peerRef.current = null;
      peer?.close();
      setPeer(null);
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setRemoteStream(null);
      connection?.close();
      setConnection(null);
      setSessionToken(null);
      setSessionId(null);
      setControlAllowed(false);
      setFileTransferAllowed(false);
      setRemoteScreen(null);
      setAccessFlowRequested(false);
      setPeerOnline(false);
      setViewMode("dashboard");
      setStatus("Sessao encerrada");

      if (auth && sessionId) {
        try {
          await endSession(sessionId, auth.token);
        } catch {
          // ignore
        }
      }
    },
    [connection, peer, auth, sessionId]
  );

  const startJoin = useCallback(async (agentIdValue: string, codeValue: string) => {
    const authState = authRef.current;
    if (!authState) return;
    try {
      if (!agentIdValue.trim() || !codeValue.trim()) {
        setStatus("Informe ID e codigo");
        return;
      }
      if (sessionId || connection) {
        await cleanupSession(true);
      }
      setViewMode("dashboard");
      setStatus("Conectando...");
      setControlAllowed(false);
      setFileTransferAllowed(false);
      const join = await joinSession(agentIdValue.trim(), codeValue.trim(), authState.token);
      setAgentId(agentIdValue);
      setCode(codeValue);
      setSessionId(join.sessionId);
      setSessionToken(join.token);

      const ws = connectSignaling(join.token, {
        onMessage: async (message: WsMessage) => {
          switch (message.type) {
            case "share_accepted":
              setStatus("Compartilhamento autorizado");
              setViewMode("viewer");
              if (accessFlowRequestedRef.current && authRef.current) {
                ws.send({ type: "request_control", payload: { fromUserId: authRef.current.user.id } });
                ws.send({ type: "request_file_transfer", payload: { fromUserId: authRef.current.user.id } });
                setStatus("Solicitando controle e transferencia...");
                setAccessFlowRequested(false);
              }
              return;
            case "peer_joined":
              if (message.payload?.role === "agent") {
                setPeerOnline(true);
              }
              return;
            case "peer_status":
              if (typeof message.payload?.online === "boolean") {
                setPeerOnline(message.payload.online);
              }
              return;
            case "share_declined":
              setStatus("Compartilhamento recusado");
              setAccessFlowRequested(false);
              return;
            case "offer":
              if (message.payload?.description) {
                await handleOffer(message.payload.description);
              }
              return;
            case "ice":
              if (peerRef.current && message.payload?.candidate) {
                await peerRef.current.addIceCandidate(message.payload.candidate);
              }
              return;
            case "control_granted":
              setControlAllowed(true);
              setStatus("Controle permitido");
              return;
            case "control_denied":
              setControlAllowed(false);
              setStatus("Controle negado");
              return;
            case "screen_info":
              if (message.payload?.width && message.payload?.height) {
                setRemoteScreen({ width: message.payload.width, height: message.payload.height });
              }
              return;
            case "file_transfer_accepted":
              setFileTransferAllowed(true);
              setStatus("Transferencia permitida (nao implementada)");
              return;
            case "file_transfer_denied":
              setFileTransferAllowed(false);
              setStatus("Transferencia negada");
              return;
            case "session_end":
              setAccessFlowRequested(false);
              cleanupSession(false);
              return;
            case "peer_left":
              setPeerOnline(false);
              setAccessFlowRequested(false);
              cleanupSession(false);
              return;
            default:
              return;
          }
        },
        onStatus: (state) => {
          if (state === "connecting") setStatus("Conectando sinalizacao...");
          if (state === "reconnecting") setStatus("Reconectando sinalizacao...");
          if (state === "open") setStatus("Conectado. Solicite compartilhamento.");
          if (state === "closed") setStatus("Conexao encerrada");
        }
      });
      setConnection(ws);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("join_failed:")) {
        const reason = err.message.replace("join_failed:", "");
        if (reason === "invalid_code") {
          setStatus("Codigo invalido");
          return;
        }
        if (reason === "expired") {
          setStatus("Codigo expirado");
          return;
        }
        if (reason === "not_found") {
          setStatus("Sessao nao encontrada");
          return;
        }
      }
      setStatus("Falha ao entrar na sessao");
    }
  }, [cleanupSession, connection, sessionId]);

  const handleJoin = async () => {
    await startJoin(agentId, code);
  };

  const handleOffer = useCallback(
    async (description: RTCSessionDescriptionInit) => {
      if (peerRef.current) {
        peerRef.current.close();
      }
      const pc = createPeerConnection();
      peerRef.current = pc;
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        setRemoteStream(remoteStream);
        if (videoRef.current) {
          videoRef.current.srcObject = remoteStream;
          videoRef.current.muted = true;
          void videoRef.current.play().catch(() => {});
        }
      };
      pc.ondatachannel = (event) => {
        dataChannelRef.current = event.channel;
      };
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          connection?.send({ type: "ice", payload: { candidate: event.candidate } });
        }
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          cleanupSession(false);
        }
      };

      await pc.setRemoteDescription(description);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      connection?.send({ type: "answer", payload: { description: pc.localDescription } });
      setPeer(pc);
      setStatus("Streaming ativo");
    },
    [connection, cleanupSession, peer]
  );

  const requestAccess = () => {
    if (!connection || !auth) return;
    setAccessFlowRequested(true);
    connection.send({ type: "request_share", payload: { fromUserId: auth.user.id } });
    setStatus(peerOnline ? "Solicitando acesso..." : "Solicitacao enviada (aguardando agente)");
  };

  const sendInput = useCallback(
    (payload: any) => {
      if (!controlAllowed) return;
      if (dataChannelRef.current?.readyState === "open") {
        dataChannelRef.current.send(JSON.stringify(payload));
      }
    },
    [controlAllowed]
  );

  const handleMouseEvent = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!videoRef.current) return;
      const rect = videoRef.current.getBoundingClientRect();
      const relX = (event.clientX - rect.left) / rect.width;
      const relY = (event.clientY - rect.top) / rect.height;
      const width = remoteScreen?.width ?? videoRef.current.videoWidth ?? rect.width;
      const height = remoteScreen?.height ?? videoRef.current.videoHeight ?? rect.height;
      const x = Math.max(0, Math.min(Math.round(relX * width), width));
      const y = Math.max(0, Math.min(Math.round(relY * height), height));

      if (event.type === "mousemove") {
        sendInput({ type: "MouseMove", x, y });
      }
      if (event.type === "mousedown") {
        const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
        sendInput({ type: "MouseDown", button });
      }
      if (event.type === "mouseup") {
        const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
        sendInput({ type: "MouseUp", button });
      }
    },
    [sendInput, remoteScreen]
  );

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!controlAllowed) return;
      event.preventDefault();
      sendInput({ type: "MouseWheel", delta_x: Math.round(event.deltaX), delta_y: Math.round(event.deltaY) });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!controlAllowed) return;
      sendInput({ type: "KeyDown", key: event.key });
      event.preventDefault();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!controlAllowed) return;
      sendInput({ type: "KeyUp", key: event.key });
      event.preventDefault();
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [controlAllowed, sendInput]);

  const sessionLabel = useMemo(() => {
    if (!sessionId) return "-";
    return sessionId.slice(0, 8);
  }, [sessionId]);

  if (!auth) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-obsidian via-plum to-obsidian p-8">
        <div className="panel mx-auto max-w-md rounded-3xl p-8">
          <h1 className="text-3xl font-semibold text-cloud">Controller Login</h1>
          <p className="mt-2 text-mist">Acesso exclusivo para tecnicos autorizados.</p>
          <div className="mt-6 space-y-4">
            <input
              className="w-full rounded-lg bg-obsidian/60 px-4 py-2 text-cloud"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <input
              className="w-full rounded-lg bg-obsidian/60 px-4 py-2 text-cloud"
              placeholder="Senha"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className="w-full rounded-lg bg-ember px-4 py-2 font-semibold text-obsidian"
              onClick={handleLogin}
            >
              Entrar
            </button>
            <p className="text-sm text-mist">Status: {status}</p>
          </div>
        </div>
      </div>
    );
  }

  if (viewMode === "viewer") {
    return (
      <div className="fixed inset-0 bg-obsidian">
        <div className="absolute inset-0">
          <div
            className="h-full w-full"
            onMouseMove={handleMouseEvent}
            onMouseDown={handleMouseEvent}
            onMouseUp={handleMouseEvent}
            onContextMenu={(event) => event.preventDefault()}
          >
            <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />
          </div>
        </div>

        <div className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-between gap-3 bg-obsidian/80 px-4 py-3 backdrop-blur">
          <div>
            <h1 className="text-lg font-semibold text-cloud">Tela remota</h1>
            <p className="text-xs text-mist">
              Sessao: {sessionLabel} | Status: {status} | Agente: {peerOnline ? "online" : "offline"} | Controle: {controlAllowed ? "ON" : "OFF"}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              className="rounded-lg border border-cloud/40 px-4 py-2 text-cloud"
              onClick={requestAccess}
            >
              Solicitar acesso
            </button>
            <button
              className="rounded-lg bg-ember px-4 py-2 font-semibold text-obsidian"
              onClick={() => cleanupSession(true)}
            >
              Encerrar
            </button>
          </div>
        </div>

        {fileTransferAllowed && (
          <div className="absolute bottom-4 left-4 rounded-lg bg-obsidian/80 px-3 py-2 text-xs text-mist backdrop-blur">
            Transferencia permitida, mas funcionalidade nao implementada.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-obsidian via-plum to-obsidian p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="panel flex flex-wrap items-center justify-between gap-4 rounded-3xl p-6">
          <div>
            <h1 className="text-3xl font-semibold text-cloud">Remote Support Controller</h1>
            <p className="text-mist">Tecnico: {auth.user.email}</p>
          </div>
          <button className="rounded-lg border border-cloud/40 px-4 py-2 text-cloud" onClick={handleLogout}>
            Sair
          </button>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
          <section className="panel rounded-3xl p-6">
            <h2 className="text-xl font-semibold text-cloud">Sessoes ativas</h2>
            <div className="mt-4 space-y-3">
              {sessions.length === 0 && <p className="text-mist">Nenhuma sessao ativa.</p>}
              {sessions.map((item) => (
                <div
                  key={item.sessionId}
                  className="rounded-2xl border border-cloud/10 p-3 cursor-pointer hover:border-cloud/30"
                  onDoubleClick={() => {
                    const nextAgentId = item.agentId;
                    const nextCode = item.code ?? "";
                    if (!nextCode) {
                      setStatus("Codigo indisponivel. Atualize a lista.");
                      return;
                    }
                    startJoin(nextAgentId, nextCode);
                  }}
                  title="Duplo clique para preencher o Agent ID"
                >
                  <p className="text-sm text-mist">Usuario</p>
                  <p className="font-semibold text-cloud">
                    {item.agentName ? item.agentName : "Sem nome"}
                  </p>
                  <p className="mt-1 text-xs text-mist/80 break-all">{item.agentId}</p>
                  {item.code && (
                    <p className="mt-1 text-xs text-mist/80">Codigo: {item.code}</p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-mist">
              Dica: duplo clique no usuario para entrar na sessao automaticamente.
            </p>
            <button
              className="mt-4 rounded-lg border border-cloud/20 px-3 py-2 text-mist"
              onClick={refreshSessions}
            >
              Atualizar lista
            </button>
          </section>

          <section className="panel rounded-3xl p-6">
            <h2 className="text-xl font-semibold text-cloud">Conectar</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <input
                className="rounded-lg bg-obsidian/60 px-4 py-2 text-cloud"
                placeholder="Agent ID"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              />
              <input
                className="rounded-lg bg-obsidian/60 px-4 py-2 text-cloud"
                placeholder="Codigo"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleJoin();
                  }
                }}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className="rounded-lg border border-cloud/40 px-4 py-2 text-cloud"
                onClick={requestAccess}
              >
                Solicitar acesso
              </button>
            </div>
            <div className="mt-4 text-sm text-mist">
              Sessao: {sessionLabel} | Status: {status} | Agente: {peerOnline ? "online" : "offline"} | Controle: {controlAllowed ? "ON" : "OFF"}
            </div>
          </section>
        </div>

        <section className="panel rounded-3xl p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-cloud">Tela remota</h2>
            <button
              className="rounded-lg border border-cloud/40 px-4 py-2 text-cloud"
              onClick={() => setViewMode("viewer")}
            >
              Abrir em tela dedicada
            </button>
          </div>
          <p className="mt-3 text-sm text-mist">
            Quando o Agent aceitar o compartilhamento, a tela remota abre automaticamente em modo dedicado.
          </p>
        </section>
      </div>
    </div>
  );
}

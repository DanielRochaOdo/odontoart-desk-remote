import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "./components/Modal";
import { createSession, endSession, sendAudit } from "./lib/api";
import { connectSignaling, type WsMessage } from "./lib/signaling";
import { createPeerConnection } from "./lib/webrtc";
import { invokeSafe } from "./lib/tauri";

interface SessionInfo {
  agentId: string;
  sessionId: string;
  code: string;
  codeExpiresAt: number;
  token: string;
}

const generateAgentId = () => {
  const stored = localStorage.getItem("agentId");
  if (stored) return stored;
  const id = (crypto as any).randomUUID ? crypto.randomUUID() : `agent-${Date.now()}`;
  localStorage.setItem("agentId", id);
  return id;
};

const getOrCreateFixedCode = () => {
  const stored = localStorage.getItem("agentFixedCode");
  if (stored) return stored;
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += Math.floor(Math.random() * 10).toString();
  }
  localStorage.setItem("agentFixedCode", code);
  return code;
};

export default function App() {
  const [agentId] = useState(generateAgentId);
  const [agentFixedCode] = useState(getOrCreateFixedCode);
  const [agentName, setAgentName] = useState(() => localStorage.getItem("agentName") ?? "");
  const [isLoggedIn, setIsLoggedIn] = useState(() => Boolean(localStorage.getItem("agentName")));
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [connection, setConnection] = useState<ReturnType<typeof connectSignaling> | null>(null);
  const [peer, setPeer] = useState<RTCPeerConnection | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState("Aguardando login");
  const [pendingShare, setPendingShare] = useState<{ fromUserId: string } | null>(null);
  const [pendingControl, setPendingControl] = useState<{ fromUserId: string } | null>(null);
  const [pendingFileTransfer, setPendingFileTransfer] = useState<{ fromUserId: string } | null>(null);
  const [allowControlRequests, setAllowControlRequests] = useState(true);
  const [controlAllowed, setControlAllowed] = useState(false);
  const [fileTransferAllowed, setFileTransferAllowed] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [peerOnline, setPeerOnline] = useState(false);
  const [sendAuditLogs, setSendAuditLogs] = useState(false);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const controlAllowedRef = useRef(false);
  const allowControlRequestsRef = useRef(false);
  const localOverrideRef = useRef(0);
  const creatingSessionRef = useRef(false);

  useEffect(() => {
    controlAllowedRef.current = controlAllowed;
  }, [controlAllowed]);

  useEffect(() => {
    allowControlRequestsRef.current = allowControlRequests;
  }, [allowControlRequests]);

  useEffect(() => {
    const triggerOverride = () => {
      if (!sessionActive || !controlAllowed) return;
      const now = Date.now();
      if (now - localOverrideRef.current < 500) return;
      localOverrideRef.current = now;
      invokeSafe("set_local_override", { duration_ms: 2000 });
    };

    window.addEventListener("mousemove", triggerOverride, { passive: true });
    window.addEventListener("mousedown", triggerOverride);
    window.addEventListener("keydown", triggerOverride);
    window.addEventListener("wheel", triggerOverride, { passive: true });
    window.addEventListener("touchstart", triggerOverride, { passive: true });
    return () => {
      window.removeEventListener("mousemove", triggerOverride);
      window.removeEventListener("mousedown", triggerOverride);
      window.removeEventListener("keydown", triggerOverride);
      window.removeEventListener("wheel", triggerOverride);
      window.removeEventListener("touchstart", triggerOverride);
    };
  }, [sessionActive, controlAllowed]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sessionExpiresIn = useMemo(() => {
    if (!session) return "-";
    const delta = session.codeExpiresAt - Date.now();
    if (delta <= 0) return "expirado";
    const minutes = Math.ceil(delta / 60000);
    return `${minutes} min`;
  }, [session, now]);

  const appendAudit = useCallback((event: string, details: Record<string, unknown> = {}) => {
    setAuditEvents((prev) => [...prev, { timestamp: new Date().toISOString(), event, details }]);
  }, []);

  const cleanupPeer = useCallback(() => {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current = null;
    peer?.getSenders().forEach((sender) => sender.track?.stop());
    peer?.close();
    setPeer(null);
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
  }, [peer, stream]);

  const endLocalSession = useCallback(
    async (notifyRemote: boolean) => {
      if (notifyRemote) {
        connection?.send({ type: "session_end", payload: { reason: "ended_by_agent" } });
      }

      cleanupPeer();
      connection?.close();
      setConnection(null);
      setSessionActive(false);
      setControlAllowed(false);
      setFileTransferAllowed(false);
      setPendingShare(null);
      setPendingControl(null);
      setPendingFileTransfer(null);
      setViewerId(null);
      setPeerOnline(false);
      setStatus("Sessao encerrada");

      if (session) {
        await invokeSafe("set_control_allowed", { allowed: false });
        await invokeSafe("set_session_state", {
          sessionId: session.sessionId,
          controllerUserId: viewerId,
          active: false
        });
        appendAudit("session_ended", { sessionId: session.sessionId, viewerId });

        try {
          await endSession(session.sessionId, session.token);
        } catch {
          // best effort
        }

        if (sendAuditLogs && auditEvents.length) {
          try {
            await sendAudit(session.token, session.sessionId, auditEvents);
          } catch {
            // ignore
          }
        }
        setAuditEvents([]);
      }
    },
    [cleanupPeer, connection, session, sendAuditLogs, auditEvents, appendAudit, viewerId]
  );

  const handleGenerateSession = useCallback(async () => {
    if (creatingSessionRef.current) return;
    creatingSessionRef.current = true;
    try {
      if (sessionActive || connection) {
        await endLocalSession(true);
      }
      setStatus("Gerando codigo...");
      const created = await createSession(agentId, agentName, agentFixedCode);
      setSession(created);
      setAuditEvents([]);
      setStatus("Aguardando solicitacao do tecnico");

      const ws = connectSignaling(created.token, {
        onMessage: async (message: WsMessage) => {
          switch (message.type) {
            case "request_share":
              setPendingShare({ fromUserId: message.payload?.fromUserId ?? "tecnico" });
              return;
            case "peer_joined":
              if (message.payload?.role === "controller") {
                setPeerOnline(true);
                if (message.payload?.userId) {
                  setViewerId(message.payload.userId);
                }
                if (!sessionActive) {
                  setStatus("Tecnico conectado. Aguardando solicitacao");
                }
              }
              return;
            case "peer_status":
              if (typeof message.payload?.online === "boolean") {
                setPeerOnline(message.payload.online);
              }
              return;
            case "request_control":
              if (!allowControlRequestsRef.current) {
                ws.send({ type: "control_denied" });
                return;
              }
              setPendingControl({ fromUserId: message.payload?.fromUserId ?? "tecnico" });
              return;
            case "request_file_transfer":
              setPendingFileTransfer({ fromUserId: message.payload?.fromUserId ?? "tecnico" });
              return;
            case "answer":
              if (peerRef.current && message.payload?.description) {
                await peerRef.current.setRemoteDescription(message.payload.description);
              }
              return;
            case "ice":
              if (peerRef.current && message.payload?.candidate) {
                await peerRef.current.addIceCandidate(message.payload.candidate);
              }
              return;
            case "session_end":
              await endLocalSession(false);
              return;
            case "peer_left":
              setPeerOnline(false);
              await endLocalSession(false);
              return;
            default:
              return;
          }
        },
        onStatus: (state) => {
          if (state === "connecting") setStatus("Conectando sinalizacao...");
          if (state === "reconnecting") setStatus("Reconectando sinalizacao...");
          if (state === "open") setStatus("Aguardando solicitacao do tecnico (sinalizacao conectada)");
          if (state === "closed") setStatus("Conexao de sinalizacao encerrada");
        },
        onClose: () => {
          setStatus("Conexao de sinalizacao encerrada");
        }
      });
      setConnection(ws);
    } catch (err) {
      setStatus("Falha ao gerar codigo");
    } finally {
      creatingSessionRef.current = false;
    }
  }, [agentId, agentName, agentFixedCode, connection, endLocalSession, sessionActive]);

  useEffect(() => {
    if (isLoggedIn && !session && !connection && !creatingSessionRef.current) {
      handleGenerateSession();
    }
  }, [isLoggedIn, session, connection, handleGenerateSession]);

  const handleLogin = async () => {
    const trimmed = agentName.trim();
    if (!trimmed) {
      setStatus("Informe seu nome");
      return;
    }
    localStorage.setItem("agentName", trimmed);
    setIsLoggedIn(true);
  };

  const handleLogout = async () => {
    localStorage.removeItem("agentName");
    setIsLoggedIn(false);
    setAgentName("");
    setSession(null);
    await endLocalSession(true);
    setStatus("Aguardando login");
  };

  const acceptShare = async () => {
    if (!connection || !session) return;
    const viewer = pendingShare?.fromUserId ?? "tecnico";
    setPendingShare(null);
    setStatus("Iniciando compartilhamento...");

    try {
      const pc = createPeerConnection();
      peerRef.current = pc;
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          connection.send({ type: "ice", payload: { candidate: event.candidate } });
        }
      };
      const controlChannel = pc.createDataChannel("control");
      dataChannelRef.current = controlChannel;
      controlChannel.onmessage = async (msg) => {
        if (!controlAllowedRef.current) return;
        try {
          const payload = JSON.parse(msg.data);
          await invokeSafe("inject_input", { event: payload });
        } catch {
          // ignore
        }
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
          endLocalSession(false);
        }
      };

      const media = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 30,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      media.getTracks().forEach((track) => pc.addTrack(track, media));
      setStream(media);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      connection.send({ type: "offer", payload: { description: pc.localDescription } });

      setPeer(pc);
      setSessionActive(true);
      setControlAllowed(false);
      setFileTransferAllowed(false);
      setViewerId(viewer);
      setStatus("Compartilhando tela");
      appendAudit("share_started", { viewerId: viewer });

      await invokeSafe("set_session_state", {
        sessionId: session.sessionId,
        controllerUserId: viewer,
        active: true
      });
      await invokeSafe("set_control_allowed", { allowed: false });

      const screenSize = await invokeSafe<[number, number]>("get_screen_size");
      if (screenSize) {
        connection.send({ type: "screen_info", payload: { width: screenSize[0], height: screenSize[1] } });
      }

      connection.send({ type: "share_accepted" });
    } catch {
      connection.send({ type: "share_declined" });
      setStatus("Compartilhamento cancelado");
    }
  };

  const declineShare = () => {
    connection?.send({ type: "share_declined" });
    setPendingShare(null);
    setStatus("Compartilhamento recusado");
  };

  const acceptControl = async () => {
    setPendingControl(null);
    setControlAllowed(true);
    setStatus("Controle permitido");
    connection?.send({ type: "control_granted" });
    appendAudit("control_granted");
    await invokeSafe("set_control_allowed", { allowed: true });
  };

  const declineControl = () => {
    setPendingControl(null);
    connection?.send({ type: "control_denied" });
    setStatus("Controle negado");
  };

  const acceptFileTransfer = () => {
    setPendingFileTransfer(null);
    setFileTransferAllowed(true);
    connection?.send({ type: "file_transfer_accepted" });
    appendAudit("file_transfer_permission", { allowed: true });
    setStatus("Transferencia permitida (nao implementada)");
  };

  const declineFileTransfer = () => {
    setPendingFileTransfer(null);
    setFileTransferAllowed(false);
    connection?.send({ type: "file_transfer_denied" });
    appendAudit("file_transfer_permission", { allowed: false });
    setStatus("Transferencia negada");
  };

  const exportAuditLog = async () => {
    const contents = await invokeSafe<string>("get_audit_log");
    if (!contents) return;
    const blob = new Blob([contents], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `audit-${agentId}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-ink via-steel to-lake p-8">
        <div className="glass mx-auto max-w-lg rounded-3xl p-8">
          <h1 className="text-3xl font-semibold text-sand">Remote Support Agent</h1>
          <p className="mt-2 text-sand/70">
            Informe seu nome para gerar o codigo de acesso imediatamente ao entrar.
          </p>
          <div className="mt-6 space-y-4">
            <input
              className="w-full rounded-lg border border-sand/20 bg-ink/40 px-4 py-2 text-sand"
              placeholder="Seu nome ou empresa"
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleLogin();
                }
              }}
            />
            <button
              className="w-full rounded-lg bg-mint px-4 py-2 text-ink font-semibold hover:bg-mint/90"
              onClick={handleLogin}
            >
              Entrar e gerar codigo
            </button>
            <p className="text-sm text-sand/60">Status: {status}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-ink via-steel to-lake p-8">
      {sessionActive && (
        <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between bg-alert/90 px-6 py-3 text-sand shadow-lg">
          <span className="font-semibold">Voce esta sendo assistido agora</span>
          <button
            className="rounded bg-sand px-4 py-2 text-ink font-semibold"
            onClick={() => endLocalSession(true)}
          >
            Encerrar sessao
          </button>
        </div>
      )}

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="glass rounded-3xl p-8">
          <h1 className="text-3xl font-semibold text-sand">Remote Support Agent</h1>
          <p className="mt-2 text-sand/70">Compartilhamento seguro com consentimento explicito.</p>
          <div className="mt-4 flex items-center justify-between text-sm text-sand/70">
            <span>Logado como: {agentName}</span>
            <button
              className="rounded border border-sand/30 px-3 py-1 text-sand/80 hover:text-sand"
              onClick={handleLogout}
            >
              Trocar usuario
            </button>
          </div>

          <div className="mt-8 space-y-6">
            <div className="rounded-2xl border border-mint/30 p-4">
              <p className="text-sm text-sand/60">Seu ID</p>
              <p className="text-xl font-semibold text-sand break-all">{agentId}</p>
            </div>

            <div className="rounded-2xl border border-mint/30 p-4">
              <p className="text-sm text-sand/60">Codigo fixo da maquina (expira em {sessionExpiresIn})</p>
              <p className="text-2xl font-semibold text-mint">{session?.code ?? "-"}</p>
              <button
                className="mt-4 rounded-lg bg-mint px-4 py-2 text-ink font-semibold hover:bg-mint/90"
                onClick={handleGenerateSession}
              >
                Reiniciar sessao
              </button>
              <p className="mt-2 text-xs text-sand/60">O codigo nao muda entre sessoes.</p>
            </div>

            <label className="flex items-center justify-between rounded-2xl border border-mint/30 p-4">
              <span className="text-sand">Permitir controle (ainda requer confirmacao)</span>
              <input
                type="checkbox"
                checked={allowControlRequests}
                onChange={(event) => setAllowControlRequests(event.target.checked)}
                className="h-5 w-5 accent-mint"
              />
            </label>

            <label className="flex items-center justify-between rounded-2xl border border-mint/30 p-4">
              <span className="text-sand">Enviar logs ao servidor (opcional)</span>
              <input
                type="checkbox"
                checked={sendAuditLogs}
                onChange={(event) => setSendAuditLogs(event.target.checked)}
                className="h-5 w-5 accent-mint"
              />
            </label>

            <button
              className="rounded-lg border border-sand/50 px-4 py-2 text-sand/80 hover:text-sand"
              onClick={exportAuditLog}
            >
              Exportar log local (JSON)
            </button>
          </div>
        </section>

        <section className="glass rounded-3xl p-8">
          <h2 className="text-xl font-semibold text-sand">Status da sessao</h2>
          <p className="mt-4 text-sand/70">{status}</p>

          <div className="mt-8 space-y-4">
            <div className="rounded-2xl border border-sand/20 p-4">
              <p className="text-sm text-sand/60">Visualizacao</p>
              <p className="text-lg font-semibold text-sand">
                {sessionActive ? "Ativa" : "Inativa"}
              </p>
            </div>
            <div className="rounded-2xl border border-sand/20 p-4">
              <p className="text-sm text-sand/60">Controle de input</p>
              <p className="text-lg font-semibold text-sand">
                {controlAllowed ? "Permitido" : "Nao permitido"}
              </p>
            </div>
            <div className="rounded-2xl border border-sand/20 p-4">
              <p className="text-sm text-sand/60">Transferencia de arquivo</p>
              <p className="text-lg font-semibold text-sand">
                {fileTransferAllowed ? "Permitida (nao implementada)" : "Nao permitida"}
              </p>
            </div>
            <div className="rounded-2xl border border-sand/20 p-4">
              <p className="text-sm text-sand/60">Tecnico conectado</p>
              <p className="text-lg font-semibold text-sand">
                {viewerId ?? "-"}
              </p>
            </div>
          </div>
        </section>
      </div>

      <Modal
        open={Boolean(pendingShare)}
        title="Solicitacao de acesso"
        description={`${pendingShare?.fromUserId ?? "Tecnico"} quer acessar sua tela. Aceitar?`}
        confirmLabel="Aceitar"
        cancelLabel="Recusar"
        onConfirm={acceptShare}
        onCancel={declineShare}
      />

      <Modal
        open={Boolean(pendingControl)}
        title="Permitir controle"
        description="Permitir controle do mouse e teclado?"
        confirmLabel="Permitir"
        cancelLabel="Negar"
        onConfirm={acceptControl}
        onCancel={declineControl}
      />

      <Modal
        open={Boolean(pendingFileTransfer)}
        title="Permitir transferencia"
        description="Permitir transferencia de arquivo? (funcionalidade nao implementada)"
        confirmLabel="Permitir"
        cancelLabel="Negar"
        onConfirm={acceptFileTransfer}
        onCancel={declineFileTransfer}
      />
    </div>
  );
}

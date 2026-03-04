import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Modal from "./components/Modal";
import { createSession, endSession, sendAudit } from "./lib/api";
import { connectSignaling, type WsMessage } from "./lib/signaling";
import { createPeerConnection } from "./lib/webrtc";
import { invokeSafe, isTauri } from "./lib/tauri";

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
  const [allowFileTransferRequests, setAllowFileTransferRequests] = useState(true);
  const [controlAllowed, setControlAllowed] = useState(false);
  const [fileTransferAllowed, setFileTransferAllowed] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [peerOnline, setPeerOnline] = useState(false);
  const [sendAuditLogs, setSendAuditLogs] = useState(false);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [fileTransferStatus, setFileTransferStatus] = useState("");
  const [screenSelectionError, setScreenSelectionError] = useState<{ viewerId: string } | null>(null);
  const [nativeCaptureError, setNativeCaptureError] = useState<string | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const fileChannelRef = useRef<RTCDataChannel | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const controlAllowedRef = useRef(false);
  const fileTransferAllowedRef = useRef(false);
  const allowControlRequestsRef = useRef(false);
  const allowFileTransferRequestsRef = useRef(false);
  const localOverrideRef = useRef(0);
  const creatingSessionRef = useRef(false);
  const lastIceRestartRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCaptureUnlistenRef = useRef<null | (() => void)>(null);
  const nativeCaptureActiveRef = useRef(false);
  const nativeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const nativeDrawingRef = useRef(false);
  const incomingFileRef = useRef<{
    id: string;
    name: string;
    size: number;
    mime: string;
    received: number;
    chunks: Uint8Array[];
  } | null>(null);

  useEffect(() => {
    controlAllowedRef.current = controlAllowed;
  }, [controlAllowed]);

  useEffect(() => {
    fileTransferAllowedRef.current = fileTransferAllowed;
  }, [fileTransferAllowed]);

  useEffect(() => {
    allowControlRequestsRef.current = allowControlRequests;
  }, [allowControlRequests]);

  useEffect(() => {
    allowFileTransferRequestsRef.current = allowFileTransferRequests;
  }, [allowFileTransferRequests]);

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

  const stopNativeCapture = useCallback(async () => {
    if (!isTauri()) return;
    if (nativeCaptureUnlistenRef.current) {
      nativeCaptureUnlistenRef.current();
      nativeCaptureUnlistenRef.current = null;
    }
    nativeCaptureActiveRef.current = false;
    nativeCanvasRef.current = null;
    nativeDrawingRef.current = false;
    await invokeSafe("stop_native_capture");
  }, []);

  const startNativeCapture = useCallback(async (): Promise<MediaStream | null> => {
    if (!isTauri()) return null;
    if (nativeCaptureActiveRef.current && nativeCanvasRef.current) {
      return nativeCanvasRef.current.captureStream(30);
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas_context");
    }
    nativeCanvasRef.current = canvas;

    const unlisten = await listen<{
      data: string;
      width: number;
      height: number;
    }>("native_capture_frame", async (event) => {
      if (nativeDrawingRef.current) return;
      const payload = event.payload;
      if (!payload?.data) return;
      nativeDrawingRef.current = true;
      try {
        if (
          payload.width &&
          payload.height &&
          (canvas.width !== payload.width || canvas.height !== payload.height)
        ) {
          canvas.width = payload.width;
          canvas.height = payload.height;
        }

        const binary = atob(payload.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      } catch {
        // ignore frame errors
      } finally {
        nativeDrawingRef.current = false;
      }
    });

    nativeCaptureUnlistenRef.current = unlisten;
    nativeCaptureActiveRef.current = true;
    await invokeSafe("start_native_capture", { fps: 15, quality: 60 });
    return canvas.captureStream(30);
  }, [stopNativeCapture]);

  useEffect(() => {
    if (!isTauri()) return undefined;
    let unlisten: null | (() => void) = null;
    listen<string>("native_capture_error", (event) => {
      const payload = typeof event.payload === "string" ? event.payload : "capture_error";
      setNativeCaptureError(payload);
      setStatus("Falha na captura nativa. Verifique as permissoes.");
      void stopNativeCapture();
    }).then((handler) => {
      unlisten = handler;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [stopNativeCapture]);

  const setupFileChannel = useCallback(
    (channel: RTCDataChannel) => {
      fileChannelRef.current = channel;
      channel.binaryType = "arraybuffer";
      channel.onmessage = (msg) => {
        if (!fileTransferAllowedRef.current && !allowFileTransferRequestsRef.current) return;
        if (typeof msg.data === "string") {
          try {
            const payload = JSON.parse(msg.data);
            if (payload?.type === "file_meta") {
              incomingFileRef.current = {
                id: payload.id,
                name: payload.name,
                size: payload.size,
                mime: payload.mime || "application/octet-stream",
                received: 0,
                chunks: []
              };
              setFileTransferStatus(`Recebendo ${payload.name}...`);
              appendAudit("file_transfer_started", { name: payload.name, size: payload.size });
            }
            if (payload?.type === "file_end" && incomingFileRef.current) {
              const incoming = incomingFileRef.current;
              const blob = new Blob(incoming.chunks, { type: incoming.mime });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = incoming.name || `arquivo-${incoming.id}`;
              link.click();
              URL.revokeObjectURL(url);
              appendAudit("file_transfer_completed", { name: incoming.name, size: incoming.size });
              setFileTransferStatus(`Arquivo recebido: ${incoming.name}`);
              incomingFileRef.current = null;
            }
          } catch {
            // ignore
          }
          return;
        }
        if (msg.data instanceof ArrayBuffer && incomingFileRef.current) {
          const chunk = new Uint8Array(msg.data);
          incomingFileRef.current.chunks.push(chunk);
          incomingFileRef.current.received += chunk.byteLength;
          const received = incomingFileRef.current.received;
          const total = incomingFileRef.current.size;
          if (total > 0) {
            const percent = Math.min(100, Math.round((received / total) * 100));
            setFileTransferStatus(`Recebendo ${incomingFileRef.current.name}... ${percent}%`);
          }
        }
      };
    },
    [appendAudit]
  );

  const cleanupPeer = useCallback(() => {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    fileChannelRef.current?.close();
    fileChannelRef.current = null;
    peerRef.current = null;
    void stopNativeCapture();
    peer?.getSenders().forEach((sender) => sender.track?.stop());
    peer?.close();
    setPeer(null);
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    incomingFileRef.current = null;
    setFileTransferStatus("");
  }, [peer, stream, stopNativeCapture]);

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
      setFileTransferStatus("");

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
              if (controlAllowedRef.current) {
                ws.send({ type: "control_granted" });
                return;
              }
              setPendingControl({ fromUserId: message.payload?.fromUserId ?? "tecnico" });
              return;
            case "request_file_transfer":
              if (!allowFileTransferRequestsRef.current) {
                ws.send({ type: "file_transfer_denied" });
                return;
              }
              if (fileTransferAllowedRef.current) {
                ws.send({ type: "file_transfer_accepted" });
                return;
              }
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
    setPendingControl(null);
    setPendingFileTransfer(null);
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
      const fileChannel = pc.createDataChannel("file");
      setupFileChannel(fileChannel);
      pc.ondatachannel = (event) => {
        if (event.channel.label === "file") {
          setupFileChannel(event.channel);
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
          const now = Date.now();
          if (now - lastIceRestartRef.current > 5000 && typeof pc.restartIce === "function") {
            lastIceRestartRef.current = now;
            try {
              pc.restartIce();
              setStatus("Reconectando midia...");
              return;
            } catch {
              // fallthrough
            }
          }
        }
        if (pc.connectionState === "closed") {
          endLocalSession(false);
        }
      };

      if (!isTauri()) {
        setStatus("Este aplicativo funciona somente no modo desktop.");
        connection.send({ type: "share_declined" });
        return;
      }

      setStatus("Iniciando captura nativa...");
      const media = await startNativeCapture();
      if (!media) {
        setNativeCaptureError("capture_unavailable");
        setStatus("Captura nativa indisponivel. Verifique permissoes.");
        connection.send({ type: "share_declined" });
        return;
      }

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

      if (allowControlRequestsRef.current) {
        setControlAllowed(true);
        connection.send({ type: "control_granted" });
        appendAudit("control_granted", { auto: true });
        await invokeSafe("set_control_allowed", { allowed: true });
        setStatus("Compartilhando tela (controle permitido)");
      }
      if (allowFileTransferRequestsRef.current) {
        setFileTransferAllowed(true);
        connection.send({ type: "file_transfer_accepted" });
        appendAudit("file_transfer_permission", { allowed: true, auto: true });
        setFileTransferStatus("Transferencia de arquivos permitida");
      }
    } catch {
      await stopNativeCapture();
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
    setStatus("Transferencia permitida");
    setFileTransferStatus("Transferencia de arquivos permitida");
  };

  const declineFileTransfer = () => {
    setPendingFileTransfer(null);
    setFileTransferAllowed(false);
    connection?.send({ type: "file_transfer_denied" });
    appendAudit("file_transfer_permission", { allowed: false });
    setStatus("Transferencia negada");
    setFileTransferStatus("");
  };

  const sendFile = useCallback(async (file: File) => {
    if (!peerRef.current) {
      setFileTransferStatus("Sem conexao para envio");
      return;
    }
    if (!fileTransferAllowedRef.current) {
      setFileTransferStatus("Transferencia nao permitida");
      return;
    }
    const channel = fileChannelRef.current;
    if (!channel) {
      setFileTransferStatus("Canal de arquivo indisponivel");
      return;
    }

    if (channel.readyState !== "open") {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("file_channel_timeout")), 10_000);
        channel?.addEventListener("open", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        channel?.addEventListener("close", () => {
          clearTimeout(timeout);
          reject(new Error("file_channel_closed"));
        }, { once: true });
      });
    }

    const id = (crypto as any).randomUUID ? crypto.randomUUID() : `file-${Date.now()}`;
    const mime = file.type || "application/octet-stream";
    channel.send(JSON.stringify({ type: "file_meta", id, name: file.name, size: file.size, mime }));
    setFileTransferStatus(`Enviando ${file.name}...`);

    const chunkSize = 16 * 1024;
    let offset = 0;
    channel.bufferedAmountLowThreshold = 512 * 1024;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + chunkSize);
      const buffer = await slice.arrayBuffer();
      channel.send(buffer);
      offset += buffer.byteLength;
      if (channel.bufferedAmount > 2 * 1024 * 1024) {
        await new Promise<void>((resolve) => {
          const handler = () => {
            channel?.removeEventListener("bufferedamountlow", handler);
            resolve();
          };
          channel?.addEventListener("bufferedamountlow", handler);
        });
      }
    }
    channel.send(JSON.stringify({ type: "file_end", id }));
    setFileTransferStatus(`Arquivo enviado: ${file.name}`);
    appendAudit("file_transfer_sent", { name: file.name, size: file.size });
  }, [setupFileChannel]);

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await sendFile(file);
    event.target.value = "";
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

  if (!isTauri()) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-ink via-steel to-lake p-8">
        <div className="glass mx-auto max-w-lg rounded-3xl p-8">
          <h1 className="text-3xl font-semibold text-sand">Remote Support Agent</h1>
          <p className="mt-2 text-sand/70">
            Este aplicativo funciona apenas no modo desktop (Tauri). Execute pelo instalador.
          </p>
        </div>
      </div>
    );
  }

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
              <span className="text-sand">Permitir controle automaticamente</span>
              <input
                type="checkbox"
                checked={allowControlRequests}
                onChange={(event) => setAllowControlRequests(event.target.checked)}
                className="h-5 w-5 accent-mint"
              />
            </label>

            <label className="flex items-center justify-between rounded-2xl border border-mint/30 p-4">
              <span className="text-sand">Permitir transferencia de arquivos automaticamente</span>
              <input
                type="checkbox"
                checked={allowFileTransferRequests}
                onChange={(event) => setAllowFileTransferRequests(event.target.checked)}
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

            <button
              className="rounded-lg border border-sand/50 px-4 py-2 text-sand/80 hover:text-sand"
              onClick={() => fileInputRef.current?.click()}
              disabled={!fileTransferAllowed}
              title={fileTransferAllowed ? "Enviar arquivo ao tecnico" : "Transferencia nao permitida"}
            >
              Enviar arquivo ao tecnico
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
                {fileTransferAllowed ? "Permitida" : "Nao permitida"}
              </p>
              {fileTransferStatus && <p className="mt-1 text-xs text-sand/60">{fileTransferStatus}</p>}
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
        description={`${pendingShare?.fromUserId ?? "Tecnico"} quer acessar sua tela. Ao aceitar, voce permite visualizacao${allowControlRequests ? ", controle" : ""}${allowFileTransferRequests ? " e transferencia de arquivos" : ""}.`}
        confirmLabel="Aceitar"
        cancelLabel="Recusar"
        onConfirm={acceptShare}
        onCancel={declineShare}
      />

      <Modal
        open={Boolean(screenSelectionError)}
        title="Selecione Tela Inteira"
        description="Para acesso remoto completo, selecione a opcao Tela Inteira/Monitor na janela do sistema."
        confirmLabel="Tentar novamente"
        cancelLabel="Cancelar"
        onConfirm={() => {
          const viewer = screenSelectionError?.viewerId ?? "tecnico";
          setScreenSelectionError(null);
          setPendingShare({ fromUserId: viewer });
          setTimeout(() => acceptShare(), 0);
        }}
        onCancel={() => {
          setScreenSelectionError(null);
          setStatus("Compartilhamento cancelado");
        }}
      />

      <Modal
        open={Boolean(nativeCaptureError)}
        title="Falha na captura nativa"
        description="Nao foi possivel iniciar a captura de tela. Verifique as permissoes do sistema e tente novamente."
        confirmLabel="Ok"
        cancelLabel="Fechar"
        onConfirm={() => setNativeCaptureError(null)}
        onCancel={() => setNativeCaptureError(null)}
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
        description="Permitir transferencia de arquivo?"
        confirmLabel="Permitir"
        cancelLabel="Negar"
        onConfirm={acceptFileTransfer}
        onCancel={declineFileTransfer}
      />

      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelected} />
    </div>
  );
}

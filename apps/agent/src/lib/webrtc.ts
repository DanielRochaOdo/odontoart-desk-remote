const parseList = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const createPeerConnection = () => {
  const stunUrls = parseList(import.meta.env.VITE_STUN_URLS ?? "stun:stun.l.google.com:19302");
  const turnUrls = parseList(import.meta.env.VITE_TURN_URLS ?? "");
  const iceServers: RTCIceServer[] = [];

  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL
    });
  }

  return new RTCPeerConnection({ iceServers });
};

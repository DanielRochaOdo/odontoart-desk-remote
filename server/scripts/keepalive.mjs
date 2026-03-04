const url =
  process.env.KEEPALIVE_URL ||
  process.env.RENDER_HEALTH_URL ||
  "http://localhost:8080/healthz";

const timeoutMs = Number(process.env.KEEPALIVE_TIMEOUT_MS ?? "8000");

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

try {
  const res = await fetch(url, {
    method: "GET",
    headers: { "user-agent": "render-keepalive" },
    signal: controller.signal
  });
  clearTimeout(timer);
  if (!res.ok) {
    console.error(`keepalive_failed status=${res.status}`);
    process.exit(1);
  }
  const text = await res.text();
  console.log(`keepalive_ok status=${res.status} body=${text}`);
} catch (err) {
  clearTimeout(timer);
  console.error("keepalive_error", err);
  process.exit(1);
}

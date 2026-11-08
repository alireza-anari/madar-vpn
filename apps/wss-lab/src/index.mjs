/**
 * Madar test-only Cloudflare edge.
 *
 * This is NOT a standalone VPN server. The /__probe socket verifies the
 * Cloudflare WSS handshake only. /madar-... can relay a real VMess/WS tunnel
 * ONLY after an independently installed, quota-metered Xray backend is
 * available through an approved temporary Cloudflare Tunnel origin.
 *
 * Keep the origin unset by default. No open proxy or arbitrary destination.
 */
const RELAY_PATH = /^\/madar-[a-f0-9]{24}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

function validOrigin(value) {
  if (typeof value !== "string" || value.length > 253) return false;
  const lower = value.toLowerCase();
  if (value !== lower || !lower.endsWith(".trycloudflare.com")) return false;
  const labels = lower.split(".");
  return labels.length === 3 && DNS_LABEL.test(labels[0]);
}

function probeSocket() {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let answered = false;
  server.addEventListener("message", event => {
    if (answered || event.data !== "ping") {
      server.close(1008, "Probe only");
      return;
    }
    answered = true;
    server.send("pong");
    server.close(1000, "Probe complete");
  });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const relayPath = env.RELAY_PATH;
    const originReady = validOrigin(env.UPSTREAM_HOST) && RELAY_PATH.test(relayPath);
    const upgrade = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
    if (request.method === "GET" && path === "/healthz") {
      return Response.json({
        service: "madar-wss-lab",
        mode: "test-only",
        edge: "available",
        tunnelConfigured: originReady,
        // This endpoint NEVER asserts that Xray or Irancell was tested.
        vpnReady: false,
      }, { headers: BASE_HEADERS });
    }
    if (request.method === "GET" && path === "/test") {
      const html = `<!doctype html><html lang="fa" dir="rtl"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Madar – Cloudflare WSS Lab</title>
      <style>body{font:17px system-ui;margin:0;background:#0c1220;color:#f0f5ff}
      main{max-width:620px;margin:8vh auto;padding:24px}
      section{background:#192335;border:1px solid #34435b;border-radius:16px;padding:26px}
      #status{padding:16px;border-radius:10px;background:#253650}
      small{color:#b8c8dc;line-height:1.8}a{color:#9de8ed}</style>
      </head><body><main><section><h2>☁️ آزمایش WebSocket مدار</h2>
      <p id="status">در حال بررسی مسیر WSS کلادفلر…</p>
      <small>این صفحه فقط اتصال تلفن شما به لبه Cloudflare را بررسی می‌کند.
      موفقیت آن به معنای فعال‌بودن VPN، Xray، کنترل حجم یا پایداری اتصال ایرانسل نیست.</small>
      </section></main><script>
      const status = document.getElementById("status");
      const socket = new WebSocket("wss://" + location.host + "/__probe");
      const timer = setTimeout(() => { status.textContent = "❌ پاسخی از WSS دریافت نشد"; socket.close(); }, 10000);
      socket.onopen = () => socket.send("ping");
      socket.onmessage = event => {
        clearTimeout(timer);
        status.textContent = event.data === "pong"
          ? "✅ اتصال WebSocket به لبه کلادفلر برقرار شد"
          : "❌ پاسخ غیرمنتظره از WSS";
        socket.close();
      };
      socket.onerror = () => {clearTimeout(timer);status.textContent = "❌ اتصال WSS برقرار نشد";};
      </script></body></html>`;
      return new Response(html, { headers: {
        ...BASE_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src wss://madar-wss-lab.alirezaanari117.workers.dev",
      }});
    }
    if (request.method !== "GET") return new Response("Not found", {
      status: 404, headers: BASE_HEADERS,
    });
    if (path === "/__probe") {
      if (!upgrade) return new Response("WebSocket required", {
        status: 426, headers: BASE_HEADERS,
      });
      return probeSocket();
    }
    if (!RELAY_PATH.test(path) || path !== relayPath)
      return new Response("Not found", { status: 404, headers: BASE_HEADERS });
    if (!upgrade) return new Response("WebSocket required", {
      status: 426, headers: BASE_HEADERS,
    });
    if (!validOrigin(env.UPSTREAM_HOST))
      return new Response("Test origin not configured", {
        status: 503, headers: BASE_HEADERS,
      });

    const origin = new URL("https://" + env.UPSTREAM_HOST + path);
    try {
      // The only possible target is the operator-configured HTTPS tunnel.
      // Authentication and shared-quota enforcement happen in Xray, not here.
      const response = await fetch(origin.toString(), {
        headers: { Upgrade: "websocket" },
        redirect: "error",
      });
      if (response.status !== 101 || !response.webSocket)
        return new Response("Backend unavailable", {
          status: 503, headers: BASE_HEADERS,
        });
      return new Response(null, { status: 101, webSocket: response.webSocket });
    } catch {
      return new Response("Backend unavailable", {
        status: 503, headers: BASE_HEADERS,
      });
    }
  },
};

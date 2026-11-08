/**
 * Cloudflare Pages domain reachability and WSS edge-only test for Madar.
 * No access to bot secrets, Xray, user accounts or upstream VPN servers.
 * Never advertise a VPN as ready from this page.
 */
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

const PAGE = [
  '<!doctype html><html lang="fa" dir="rtl"><head>',
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>مدار — آزمایش مسیر جایگزین کلادفلر</title>',
  '<style>body{font:16px system-ui;background:#0c1220;color:#eff7ff;margin:0;padding:24px}',
  'main{max-width:620px;margin:7vh auto;padding:24px;background:#192335;border:1px solid #41516b;border-radius:18px}',
  'h1{font-size:23px}#result{padding:16px;background:#293750;border-radius:10px;line-height:1.8}',
  'small{display:block;color:#c2ccdb;margin-top:22px;line-height:1.9}code{direction:ltr}</style>',
  '</head><body><main><h1>☁️ آزمایش مسیر جایگزین Cloudflare</h1>',
  '<p id="result">در حال آزمایش اتصال WebSocket...</p>',
  '<small>این آزمایش فقط دسترسی مرورگر به Cloudflare Pages و WSS را می‌سنجد.',
  'تأیید آن به معنی فعال بودن VPN یا Xray، پایداری در ایران یا عبور ترافیک نیست.</small>',
  '</main><script>',
  'const status = document.getElementById("result");',
  'const protocol = location.protocol === "https:" ? "wss://" : "ws://";',
  'let settled = false;',
  'const socket = new WebSocket(protocol + location.host + "/__probe");',
  'const finish = message => { if (settled) return; settled=true; clearTimeout(guard); status.textContent=message; socket.close(); };',
  'const guard = setTimeout(() => finish("❌ اتصال WSS تا ۱۰ ثانیه پاسخ نداد"), 10000);',
  'socket.onopen = () => socket.send("ping");',
  'socket.onmessage = event => finish(event.data === "pong" ? "✅ اتصال WSS از این شبکه تا Cloudflare Pages برقرار شد" : "❌ پاسخ نامعتبر از WSS");',
  'socket.onerror = () => finish("❌ اتصال WSS برقرار نشد");',
  '</script></body></html>'
].join("\n");

function probe() {
  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();
  let used = false;
  server.addEventListener("message", event => {
    if (used || event.data !== "ping") {
      server.close(1008, "Probe only");
      return;
    }
    used = true;
    server.send("pong");
    server.close(1000, "Probe complete");
  });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") return new Response("Not found", { status: 404, headers: HEADERS });
    if (path === "/healthz") return Response.json({
      service: "madar-cf-edge-probe",
      mode: "edge-only",
      platform: "cloudflare-pages",
      edge: "available",
      vpnReady: false,
      tunnelConfigured: false
    }, { headers: HEADERS });
    if (path === "/" || path === "/test") return new Response(PAGE, {
      headers: {
        ...HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss:"
      }
    });
    if (path === "/__probe") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("WebSocket required", { status: 426, headers: HEADERS });
      }
      return probe();
    }
    return new Response("Not found", { status: 404, headers: HEADERS });
  }
};

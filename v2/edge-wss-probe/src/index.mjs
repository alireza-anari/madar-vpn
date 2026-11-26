/** Standalone disposable Cloudflare WebSocket ingress probe for Madar V2.
 * Does NOT accept arbitrary destinations, expose an HTTP proxy, or alter V1.
 * The real VLESS authentication remains inside Xray on the disposable VPS.
 */
export const WORKER_HOST = 'madar-v2-wss-probe.alirezaanari117.workers.dev';
export const ORIGIN = 'https://86-54-42-66.sslip.io/madar-ws';

export function makeHandler(outboundFetch = fetch) {
  return async function handleRequest(request) {
    const target = new URL(request.url);
    if (target.hostname !== WORKER_HOST || target.search || target.hash) {
      return new Response('Not found', {status:404});
    }
    if (target.pathname === '/healthz' && request.method === 'GET') {
      return new Response('madar-v2-wss-probe staging only', {
        status:200,
        headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}
      });
    }
    if (target.pathname !== '/madar-ws' || request.method !== 'GET') {
      return new Response('Not found', {status:404});
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', {status:426});
    }
    try {
      const response = await outboundFetch(new Request(ORIGIN, {
        method:'GET',
        headers:{Upgrade:'websocket'},
        redirect:'manual',
      }));
      if (response.status !== 101 || !response.webSocket)
        return new Response('Upstream unavailable', {status:502});
      // Cloudflare tunnels the WebSocket without inspecting VLESS frames.
      return response;
    } catch {
      return new Response('Upstream unavailable', {status:502});
    }
  };
}
export default { fetch:makeHandler() };

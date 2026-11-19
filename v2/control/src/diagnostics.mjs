// Only assign a failure to an observed layer, never infer that an operator or
// Cloudflare blocked traffic from a timeout on one unrelated test.
const RESULT = Object.freeze({
  dns: 'DNS_RESOLUTION_FAILED',
  tcp: 'IP_OR_TCP_UNREACHABLE',
  udp: 'UDP_PATH_UNREACHABLE',
  tls: 'TLS_HANDSHAKE_FAILED',
  websocket: 'WEBSOCKET_UPGRADE_FAILED',
  proxy: 'PROXY_HANDSHAKE_FAILED',
  traffic: 'TUNNEL_TRAFFIC_FAILED',
});

export function diagnose(sample) {
  if (!sample || !['reality', 'wss', 'hysteria2', 'amneziawg'].includes(sample.transport)) {
    return { code: 'INVALID_SAMPLE', failedAt: null };
  }
  const steps = sample.transport === 'hysteria2' || sample.transport === 'amneziawg'
    ? ['dns', 'udp', 'proxy', 'traffic']
    : sample.transport === 'wss'
      ? ['dns', 'tcp', 'tls', 'websocket', 'proxy', 'traffic']
      : ['dns', 'tcp', 'tls', 'proxy', 'traffic'];
  for (const step of steps) {
    if (sample[step]?.ok === false) {
      return { code: RESULT[step], failedAt: step };
    }
    if (sample[step]?.ok !== true) {
      return { code: 'NOT_ENOUGH_EVIDENCE', failedAt: step };
    }
  }
  return { code: 'CONNECTED_VERIFIED', failedAt: null };
}

// An edge suspicion is meaningful only after comparing the same endpoint
// both through the CDN and directly, at approximately the same time.
export function compareEdgeVsDirect({ edge, direct } = {}) {
  if (edge?.ok === false && direct?.ok === true) return 'EDGE_PATH_SUSPECTED';
  if (edge?.ok === true && direct?.ok === false) return 'DIRECT_PATH_SUSPECTED';
  return 'UNDETERMINED';
}

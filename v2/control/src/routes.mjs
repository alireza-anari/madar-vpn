const SUPPORTED = new Set(['reality', 'wss', 'hysteria2', 'amneziawg']);

export function eligibleRoutes(routes, { nowMs, allowUdp = true, maxAgeMs = 10 * 60_000 } = {}) {
  if (!Number.isFinite(nowMs) || !Array.isArray(routes)) throw new TypeError('Invalid selection input');
  return routes.filter((route) => {
    if (!route || route.status !== 'ready' || !SUPPORTED.has(route.transport)) return false;
    if (!Number.isFinite(route.verifiedAtMs) || route.verifiedAtMs > nowMs ||
        nowMs - route.verifiedAtMs > maxAgeMs) return false;
    if (!(route.freeSlots > 0) || !(route.freeBytes > 0)) return false;
    if (!allowUdp && ['hysteria2', 'amneziawg'].includes(route.transport)) return false;
    if (route.transport === 'wss' && !(route.tlsReady && route.hostname && route.path?.startsWith('/'))) return false;
    return typeof route.id === 'string' && route.id.length > 0;
  });
}

export function rankRoutes(routes, context) {
  const { operator = 'unknown', preferRouteId = null } = context;
  const available = eligibleRoutes(routes, context);
  const score = (route) => {
    const carrier = route.byOperator?.[operator];
    const success = Number.isFinite(carrier?.successRate) ? Math.min(1, Math.max(0, carrier.successRate)) : 0.5;
    const latency = Number.isFinite(route.latencyMs) ? Math.max(0, route.latencyMs) : 1500;
    const failure = Number.isFinite(route.recentFailureRate)
      ? Math.min(1, Math.max(0, route.recentFailureRate)) : 0.5;
    return (success * 70) - (failure * 35) - (Math.min(latency, 2000) / 100)
      + (route.id === preferRouteId ? 12 : 0);
  };
  return available.slice().sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}

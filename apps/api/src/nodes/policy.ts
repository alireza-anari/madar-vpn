import { NodeControlError, type NodePolicyClient } from './index';
import { tehranDateKey } from '../credits';

export type PolicyCandidate = {
  userId: string; clientId: string; policyRevision: number;
  suspended: boolean; revoked: boolean; verified: boolean;
  freeSeconds: number; premiumUntil: string | null;
};
export type PublicationRequest = { mode: 'current' | 'empty'; ttlSeconds: number };
export type PublicationResult = { revision: number; validUntil: string; clientCount: number };
export type PolicyPublisher = {
  publish(actorId: string, nodeId: string, request: PublicationRequest, now: Date): Promise<PublicationResult>;
};

function invalid(): never {
  throw new NodeControlError(400, 'NODE_POLICY_PUBLICATION_INVALID', 'Policy publication request is invalid.');
}
export function parsePublicationRequest(input: unknown): PublicationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const request = input as Record<string, unknown>;
  if (Object.keys(request).some(key => !['mode', 'ttlSeconds'].includes(key))) return invalid();
  if (request.mode !== 'current' && request.mode !== 'empty') return invalid();
  if (!Number.isInteger(request.ttlSeconds) || Number(request.ttlSeconds) < 60 || Number(request.ttlSeconds) > 7200) return invalid();
  return { mode: request.mode, ttlSeconds: Number(request.ttlSeconds) };
}
export function compilePolicyClients(candidates: PolicyCandidate[], freeSpeedKbps: number, now: Date): NodePolicyClient[] {
  if (!Number.isInteger(freeSpeedKbps) || freeSpeedKbps < 64 || freeSpeedKbps > 1_000_000) return invalid();
  return candidates.flatMap(candidate => {
    if (candidate.suspended || candidate.revoked || !candidate.verified) return [];
    const premium = candidate.premiumUntil !== null && new Date(candidate.premiumUntil).getTime() > now.getTime();
    if (!premium && candidate.freeSeconds <= 0) return [];
    return [{ userId: candidate.userId, clientId: candidate.clientId, policyRevision: candidate.policyRevision,
      tier: premium ? 'premium' as const : 'free' as const, speedKbps: premium ? null : freeSpeedKbps }];
  });
}

export function policyValidUntil(candidates: PolicyCandidate[], ttlSeconds: number, now: Date): string {
  let deadline = now.getTime() + ttlSeconds * 1000;
  for (const candidate of candidates) {
    if (candidate.suspended || candidate.revoked || !candidate.verified) continue;
    const premiumExpiry = candidate.premiumUntil === null ? NaN : new Date(candidate.premiumUntil).getTime();
    if (premiumExpiry > now.getTime()) deadline = Math.min(deadline, premiumExpiry);
    else if (candidate.freeSeconds > 0) {
      // Tehran accounting days in this contract use UTC+03:30.
      deadline = Math.min(deadline, new Date(`${tehranDateKey(now)}T20:30:00.000Z`).getTime());
    }
  }
  return new Date(deadline).toISOString();
}

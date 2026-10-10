import type { TelemetryReport } from '../nodes';

const MAX_ACTIVE_SECONDS_MASK = (1n << 60n) - 1n;
const ACTIVE_SECONDS_HEX = /^0[0-9a-f]{15}$/;
const TRAFFIC_WINDOW = /^xray-traffic:(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/;

function assertMaskRange(mask: bigint, allowZero: boolean): void {
  if (mask < 0n || mask > MAX_ACTIVE_SECONDS_MASK || (!allowZero && mask === 0n)) {
    throw new Error('Active-second bitmap is invalid.');
  }
}

export function parseActiveSecondsHex(value: string): bigint {
  if (!ACTIVE_SECONDS_HEX.test(value)) {
    throw new Error('Active-second bitmap is invalid.');
  }
  const mask = BigInt(`0x${value}`);
  assertMaskRange(mask, false);
  return mask;
}

export function formatActiveSecondsHex(mask: bigint): string {
  assertMaskRange(mask, false);
  return mask.toString(16).padStart(16, '0');
}

export function popcount60(mask: bigint): number {
  assertMaskRange(mask, true);
  let remaining = mask;
  let count = 0;
  while (remaining !== 0n) {
    remaining &= remaining - 1n;
    count += 1;
  }
  return count;
}

export function parseTrafficWindowId(windowId: string): Date {
  const match = TRAFFIC_WINDOW.exec(windowId);
  if (!match) throw new Error('Traffic window is invalid.');
  const [, year, month, day, hour, minute] = match;
  const value = new Date(`${year}-${month}-${day}T${hour}:${minute}:00.000Z`);
  if (Number.isNaN(value.getTime())) throw new Error('Traffic window is invalid.');
  const canonical = `xray-traffic:${value.toISOString().slice(0, 16)}Z`;
  if (canonical !== windowId) throw new Error('Traffic window is invalid.');
  return value;
}

export type TelemetrySettlementResult = 'accepted' | 'duplicate' | 'conflict';

export interface TelemetrySettlement {
  accept(report: TelemetryReport): Promise<TelemetrySettlementResult>;
}

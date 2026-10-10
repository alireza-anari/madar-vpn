import type { TelemetryReport } from '../nodes';

const MAX_ACTIVE_SECONDS_MASK = (1n << 60n) - 1n;
const ACTIVE_SECONDS_HEX = /^0[0-9a-f]{15}$/;
const TRAFFIC_WINDOW = /^xray-traffic:(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/;

function assertMaskRange(mask: bigint, allowZero: boolean): void {
  if (mask < 0n || mask > MAX_ACTIVE_SECONDS_MASK || (!allowZero && mask === 0n)) {
    throw new Error('Active-second bitmap is invalid.');
  }
}

function validDate(value: Date, label: string): number {
  const timestamp = value.getTime();
  if (Number.isNaN(timestamp)) throw new Error(`${label} is invalid.`);
  return timestamp;
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

export type PremiumEntitlementEvent = Readonly<{
  eventOrder: bigint | number | string;
  effectiveAt: Date | string;
  premiumUntil: string | null;
}>;

type NormalizedEntitlementEvent = Readonly<{
  eventOrder: bigint;
  effectiveAtMs: number;
  premiumUntilMs: number | null;
}>;

function normalizeEvent(event: PremiumEntitlementEvent): NormalizedEntitlementEvent {
  let eventOrder: bigint;
  try {
    eventOrder = BigInt(event.eventOrder);
  } catch {
    throw new Error('Premium entitlement event order is invalid.');
  }
  if (eventOrder < 0n) throw new Error('Premium entitlement event order is invalid.');

  const effectiveAt = event.effectiveAt instanceof Date ? event.effectiveAt : new Date(event.effectiveAt);
  const effectiveAtMs = validDate(effectiveAt, 'Premium entitlement event time');
  let premiumUntilMs: number | null = null;
  if (event.premiumUntil !== null) {
    const premiumUntil = new Date(event.premiumUntil);
    premiumUntilMs = validDate(premiumUntil, 'Premium entitlement expiry');
  }
  return { eventOrder, effectiveAtMs, premiumUntilMs };
}

function finalEventsByEffectiveTime(events: PremiumEntitlementEvent[]): NormalizedEntitlementEvent[] {
  const normalized = events.map(normalizeEvent).sort((left, right) => {
    if (left.effectiveAtMs !== right.effectiveAtMs) return left.effectiveAtMs - right.effectiveAtMs;
    return left.eventOrder < right.eventOrder ? -1 : left.eventOrder > right.eventOrder ? 1 : 0;
  });
  const grouped: NormalizedEntitlementEvent[] = [];
  for (const event of normalized) {
    const previous = grouped.at(-1);
    if (previous?.effectiveAtMs === event.effectiveAtMs) grouped[grouped.length - 1] = event;
    else grouped.push(event);
  }
  return grouped;
}

function premiumOverlapsSecond(
  secondStartMs: number,
  secondEndMs: number,
  events: NormalizedEntitlementEvent[],
): boolean {
  let state: NormalizedEntitlementEvent | null = null;
  for (const event of events) {
    if (event.effectiveAtMs > secondStartMs) break;
    state = event;
  }
  if (state?.premiumUntilMs !== null && state.premiumUntilMs > secondStartMs) return true;

  for (const event of events) {
    if (event.effectiveAtMs <= secondStartMs) continue;
    if (event.effectiveAtMs >= secondEndMs) break;
    if (event.premiumUntilMs !== null && event.premiumUntilMs > event.effectiveAtMs) return true;
  }
  return false;
}

export function billableMaskForMinute(input: {
  minuteStart: Date;
  candidateMask: bigint;
  accountingEpoch: Date;
  entitlementEvents: PremiumEntitlementEvent[];
}): bigint {
  assertMaskRange(input.candidateMask, true);
  const minuteStartMs = validDate(input.minuteStart, 'Minute start');
  const accountingEpochMs = validDate(input.accountingEpoch, 'Accounting epoch');
  if (minuteStartMs % 60_000 !== 0) throw new Error('Minute start must be UTC-minute aligned.');

  const events = finalEventsByEffectiveTime(input.entitlementEvents);
  let billable = 0n;
  for (let second = 0; second < 60; second += 1) {
    const bit = 1n << BigInt(second);
    if ((input.candidateMask & bit) === 0n) continue;
    const secondStartMs = minuteStartMs + second * 1000;
    if (secondStartMs < accountingEpochMs) continue;
    const secondEndMs = secondStartMs + 1000;
    if (!premiumOverlapsSecond(secondStartMs, secondEndMs, events)) billable |= bit;
  }
  return billable;
}

export type TelemetrySettlementResult = 'accepted' | 'duplicate' | 'conflict';

export interface TelemetrySettlement {
  accept(report: TelemetryReport): Promise<TelemetrySettlementResult>;
}

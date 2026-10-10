import { tehranDateKey } from '../credits';
import type { TelemetryReport } from '../nodes';
import type { PgDatabase } from '../postgres/client';
import {
  billableMaskForMinute,
  parseActiveSecondsHex,
  parseTrafficWindowId,
  popcount60,
  type PremiumEntitlementEvent,
  type TelemetrySettlement,
  type TelemetrySettlementResult,
} from './index';

type QueryDatabase = Pick<PgDatabase, 'query' | 'transaction'>;

type RawTelemetryRow = Record<string, unknown> & {
  node_id: string;
  client_id: string;
  window_id: string;
  sequence: number;
  seconds: number;
  timestamp: Date | string;
  observed_from: Date | string | null;
  observed_to: Date | string | null;
  session_id: string | null;
  active_seconds_hex: string | null;
  settlement_status: 'legacy' | 'settled' | 'unmapped';
};

type UserRow = Record<string, unknown> & { user_id: string };
type IdRow = Record<string, unknown> & { id: string };
type EpochRow = Record<string, unknown> & { active_second_epoch: Date | string };
type MaskRow = Record<string, unknown> & { settled_mask: string };
type PremiumRow = Record<string, unknown> & {
  event_order: string | number | bigint;
  effective_at: Date | string;
  premium_until: Date | string | null;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null | undefined): string | null {
  return value == null ? null : toIso(value);
}

function normalizedReportPayload(report: TelemetryReport) {
  return {
    nodeId: report.nodeId,
    clientId: report.clientId,
    windowId: report.windowId,
    sequence: report.sequence,
    seconds: report.seconds,
    timestamp: toIso(report.timestamp),
    observedFrom: toNullableIso(report.observedFrom),
    observedTo: toNullableIso(report.observedTo),
    sessionId: report.sessionId ?? null,
    activeSecondsHex: report.activeSecondsHex ?? null,
  };
}

function normalizedRowPayload(row: RawTelemetryRow) {
  return {
    nodeId: row.node_id,
    clientId: row.client_id,
    windowId: row.window_id,
    sequence: row.sequence,
    seconds: row.seconds,
    timestamp: toIso(row.timestamp),
    observedFrom: toNullableIso(row.observed_from),
    observedTo: toNullableIso(row.observed_to),
    sessionId: row.session_id,
    activeSecondsHex: row.active_seconds_hex,
  };
}

function samePayload(row: RawTelemetryRow, report: TelemetryReport) {
  return JSON.stringify(normalizedRowPayload(row)) === JSON.stringify(normalizedReportPayload(report));
}

function entitlementEvents(rows: PremiumRow[]): PremiumEntitlementEvent[] {
  return rows.map((row) => ({
    eventOrder: row.event_order,
    effectiveAt: row.effective_at,
    premiumUntil: row.premium_until === null ? null : toIso(row.premium_until),
  }));
}

function billableDayGroups(minuteStart: Date, mask: bigint) {
  const groups = new Map<string, { mask: bigint; seconds: number; occurredAt: string }>();
  for (let second = 0; second < 60; second += 1) {
    const bit = 1n << BigInt(second);
    if ((mask & bit) === 0n) continue;
    const bucketStart = new Date(minuteStart.getTime() + second * 1000);
    const freeDay = tehranDateKey(bucketStart);
    const existing = groups.get(freeDay);
    if (existing) {
      existing.mask |= bit;
      existing.seconds += 1;
    } else {
      groups.set(freeDay, {
        mask: bit,
        seconds: 1,
        occurredAt: bucketStart.toISOString(),
      });
    }
  }
  return groups;
}

export class PostgresUsageSettlementStore implements TelemetrySettlement {
  constructor(private readonly db: QueryDatabase) {}

  async accept(report: TelemetryReport): Promise<TelemetrySettlementResult> {
    let incomingMask: bigint | null = null;
    let minuteStart: Date | null = null;
    if (report.activeSecondsHex !== undefined) {
      incomingMask = parseActiveSecondsHex(report.activeSecondsHex);
      minuteStart = parseTrafficWindowId(report.windowId);
      if (popcount60(incomingMask) !== report.seconds) {
        throw new Error('Telemetry seconds do not match active-second bitmap.');
      }
    }

    return this.db.transaction(async (transaction) => {
      const initialStatus = incomingMask === null ? 'legacy' : 'unmapped';
      const inserted = await transaction.query<RawTelemetryRow>(
        `INSERT INTO telemetry_reports (
           node_id, client_id, window_id, sequence, seconds, timestamp,
           observed_from, observed_to, session_id, active_seconds_hex, settlement_status
         ) VALUES (
           $1, $2, $3, $4, $5, $6::timestamptz,
           $7::timestamptz, $8::timestamptz, $9, $10, $11
         )
         ON CONFLICT (node_id, window_id, sequence) DO NOTHING
         RETURNING
           node_id, client_id, window_id, sequence, seconds, timestamp,
           observed_from, observed_to, session_id, active_seconds_hex, settlement_status`,
        [
          report.nodeId,
          report.clientId,
          report.windowId,
          report.sequence,
          report.seconds,
          report.timestamp,
          report.observedFrom ?? null,
          report.observedTo ?? null,
          report.sessionId ?? null,
          report.activeSecondsHex ?? null,
          initialStatus,
        ],
      );

      if (!inserted.rows[0]) {
        const existing = await transaction.query<RawTelemetryRow>(
          `SELECT
             node_id, client_id, window_id, sequence, seconds, timestamp,
             observed_from, observed_to, session_id, active_seconds_hex, settlement_status
           FROM telemetry_reports
           WHERE node_id = $1 AND window_id = $2 AND sequence = $3
           LIMIT 1`,
          [report.nodeId, report.windowId, report.sequence],
        );
        const row = existing.rows[0];
        if (!row) throw new Error('Telemetry conflict row disappeared during settlement.');
        return samePayload(row, report) ? 'duplicate' : 'conflict';
      }

      if (incomingMask === null || minuteStart === null) return 'accepted';

      const owner = await transaction.query<UserRow>(
        `SELECT user_id
         FROM client_credentials
         WHERE uuid = $1
         LIMIT 1`,
        [report.clientId],
      );
      const userId = owner.rows[0]?.user_id;
      if (!userId) return 'accepted';

      const userLock = await transaction.query<IdRow>(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (!userLock.rows[0]) throw new Error('Telemetry credential owner does not exist.');

      const epochResult = await transaction.query<EpochRow>(
        `SELECT active_second_epoch
         FROM usage_accounting_config
         WHERE id = 1`,
      );
      const epoch = epochResult.rows[0]?.active_second_epoch;
      if (!epoch) throw new Error('Active-second accounting epoch is missing.');
      const accountingEpoch = new Date(toIso(epoch));

      const minuteEnd = new Date(minuteStart.getTime() + 60_000);
      const premiumResult = await transaction.query<PremiumRow>(
        `SELECT event_order, effective_at, premium_until
         FROM premium_entitlement_events
         WHERE user_id = $1
           AND effective_at < $2::timestamptz
         ORDER BY effective_at ASC, event_order ASC`,
        [userId, minuteEnd.toISOString()],
      );

      await transaction.query(
        `INSERT INTO usage_active_minutes (user_id, minute_start, settled_mask, updated_at)
         VALUES ($1, $2::timestamptz, 0, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, minute_start) DO NOTHING`,
        [userId, minuteStart.toISOString()],
      );
      const minuteState = await transaction.query<MaskRow>(
        `SELECT settled_mask::text AS settled_mask
         FROM usage_active_minutes
         WHERE user_id = $1 AND minute_start = $2::timestamptz
         FOR UPDATE`,
        [userId, minuteStart.toISOString()],
      );
      const currentMask = BigInt(minuteState.rows[0]?.settled_mask ?? '0');
      const newMask = incomingMask & ~currentMask;
      const nextMask = currentMask | incomingMask;

      await transaction.query(
        `UPDATE usage_active_minutes
         SET settled_mask = $3::bigint, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND minute_start = $2::timestamptz`,
        [userId, minuteStart.toISOString(), nextMask.toString()],
      );

      const debitedMask = billableMaskForMinute({
        minuteStart,
        candidateMask: newMask,
        accountingEpoch,
        entitlementEvents: entitlementEvents(premiumResult.rows),
      });
      const debitSeconds = popcount60(debitedMask);

      await transaction.query(
        `INSERT INTO usage_debit_events (
           node_id, window_id, sequence, user_id, minute_start,
           observed_mask, new_mask, debited_mask, debit_seconds, created_at
         ) VALUES (
           $1, $2, $3, $4, $5::timestamptz,
           $6::bigint, $7::bigint, $8::bigint, $9, CURRENT_TIMESTAMP
         )`,
        [
          report.nodeId,
          report.windowId,
          report.sequence,
          userId,
          minuteStart.toISOString(),
          incomingMask.toString(),
          newMask.toString(),
          debitedMask.toString(),
          debitSeconds,
        ],
      );

      for (const [freeDay, group] of billableDayGroups(minuteStart, debitedMask)) {
        await transaction.query(
          `INSERT INTO credit_ledger (
             unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
             node_id, session_id, sequence
           ) VALUES (
             $1, $2, 'usage', $3::date, $4, $5::timestamptz,
             $6, NULL, $7
           )`,
          [
            `usage:${report.nodeId}:${report.windowId}:${report.sequence}:${freeDay}`,
            userId,
            freeDay,
            -group.seconds,
            group.occurredAt,
            report.nodeId,
            report.sequence,
          ],
        );
      }

      await transaction.query(
        `UPDATE telemetry_reports
         SET settlement_status = 'settled'
         WHERE node_id = $1 AND window_id = $2 AND sequence = $3`,
        [report.nodeId, report.windowId, report.sequence],
      );
      return 'accepted';
    });
  }
}

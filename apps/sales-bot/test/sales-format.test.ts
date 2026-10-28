import { expect, test } from "vitest";
import type { NodeCapacity } from "../src/node-capacity";
const load = () => import("../src/" + "sales-format");

const node = (patch: Partial<NodeCapacity> = {}): NodeCapacity => ({
  id: "n",
  name: "Stockholm",
  operational_status: "active",
  healthy: 1,
  last_seen: 100,
  agent_capabilities: "quota-v2,shared-443",
  max_accounts: 20,
  max_allocated_bytes: 200e9,
  reserved_accounts: 8,
  committed_bytes: 98e9,
  finalized_used_bytes: 32e9,
  uncapped_accounts: 0,
  allocated_bytes: 98e9,
  ...patch,
});

test("formats decimal traffic values compactly", async () => {
  const { formatBytes, formatOptionalBytes } = await load();
  expect(formatBytes(0)).toBe("۰ GB");
  expect(formatBytes(500e6)).toBe("۰٫۵ GB");
  expect(formatBytes(30e9)).toBe("۳۰ GB");
  expect(formatBytes(1.7e12)).toBe("۱٫۷ TB");
  expect(formatOptionalBytes(null)).toBe("نامحدود");
});

test("finite node summary exposes total, committed, finalized, sellable and slots", async () => {
  const { nodeCapacitySummary } = await load();
  const text = nodeCapacitySummary(node());
  expect(text).toContain("🟢 Stockholm");
  expect(text).toContain("کل: ۲۰۰ GB");
  expect(text).toContain("رزرو فعال: ۹۸ GB");
  expect(text).toContain("مصرف قطعی: ۳۲ GB");
  expect(text).toContain("قابل فروش: ۷۰ GB");
  expect(text).toContain("کانفیگ: ۸ / ۲۰");
  expect(text).toContain("۶۵٪");
});

test("unlimited node summary never invents a remaining byte cap", async () => {
  const { nodeCapacitySummary } = await load();
  const text = nodeCapacitySummary(
    node({ max_allocated_bytes: null, finalized_used_bytes: 0 }),
  );
  expect(text).toContain("حجم: نامحدود");
  expect(text).toContain("قابل فروش: نامحدود");
  expect(text).not.toContain("٪");
});

import {
  remainingAllocation,
  utilizationPercent,
  type NodeCapacity,
} from "./node-capacity";

const number = (value: number, maximumFractionDigits = 2) =>
  value.toLocaleString("fa-IR", { maximumFractionDigits });

export function formatBytes(bytes: number) {
  const safe = Math.max(0, Number(bytes) || 0);
  if (safe >= 1e12) return `${number(safe / 1e12)} TB`;
  return `${number(safe / 1e9, 3)} GB`;
}

export function formatOptionalBytes(bytes: number | null) {
  return bytes === null ? "نامحدود" : formatBytes(bytes);
}

export function nodeCapacitySummary(n: NodeCapacity) {
  const remaining = remainingAllocation(n);
  const percent = utilizationPercent(n);
  const slots = `${n.reserved_accounts.toLocaleString("fa-IR")} / ${n.max_accounts.toLocaleString("fa-IR")}`;
  if (n.max_allocated_bytes === null)
    return [
      `${n.healthy ? "🟢" : "🔴"} ${n.name}`,
      "حجم: نامحدود",
      "قابل فروش: نامحدود",
      `کانفیگ: ${slots}`,
    ].join("\n");
  return [
    `${n.healthy ? "🟢" : "🔴"} ${n.name}`,
    `کل: ${formatBytes(n.max_allocated_bytes)}`,
    `رزرو فعال: ${formatBytes(n.committed_bytes)}`,
    `مصرف قطعی: ${formatBytes(n.finalized_used_bytes)}`,
    `قابل فروش: ${formatBytes(remaining || 0)}`,
    `کانفیگ: ${slots}`,
    `استفاده ظرفیت: ${number(percent || 0, 1)}٪`,
  ].join("\n");
}

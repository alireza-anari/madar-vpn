import { createAccount, type AccountInput } from "./accounts";
import { listAppNodes } from "./app-dashboard";
import type { SalesActor } from "./resellers";

export type AppSaleInput = {
  kind: "sale";
  label: string;
  quotaBytes: number;
  durationSeconds: number;
  nodeId?: string;
};

export type AppSalePreview = {
  nodes: Awaited<ReturnType<typeof listAppNodes>>;
  selectedNode: null | {
    id: string;
    eligible: boolean;
    ineligibleReason?: string;
    beforeSellableBytes: number | null;
    afterSellableBytes: number | null;
    remainingSlotsBefore: number | null;
    remainingSlotsAfter: number | null;
  };
};

function validateSale(input: AppSaleInput) {
  if (
    input.kind !== "sale" ||
    typeof input.label !== "string" ||
    !input.label.trim() ||
    input.label.length > 80 ||
    !Number.isSafeInteger(input.quotaBytes) ||
    input.quotaBytes <= 0 ||
    input.quotaBytes > 1e12 ||
    !Number.isSafeInteger(input.durationSeconds) ||
    input.durationSeconds < 1 ||
    input.durationSeconds > 31536000 ||
    (input.nodeId !== undefined &&
      (typeof input.nodeId !== "string" || !input.nodeId || input.nodeId.length > 120))
  )
    throw Error("INVALID_ACCOUNT");
}

export async function previewSale(
  db: D1Database,
  actor: SalesActor,
  input: AppSaleInput,
  now: number,
): Promise<AppSalePreview> {
  validateSale(input);
  const nodes = await listAppNodes(db, actor, now, input.quotaBytes);
  const node = input.nodeId ? nodes.find((item) => item.id === input.nodeId) : undefined;
  if (input.nodeId && !node) throw Error("NODE_UNAVAILABLE");
  return {
    nodes,
    selectedNode: node
      ? {
          id: node.id,
          eligible: node.eligible,
          ...(node.ineligibleReason ? { ineligibleReason: node.ineligibleReason } : {}),
          beforeSellableBytes: node.sellableBytes,
          afterSellableBytes:
            node.sellableBytes === null
              ? null
              : Math.max(0, node.sellableBytes - input.quotaBytes),
          remainingSlotsBefore: node.remainingSlots,
          remainingSlotsAfter:
            node.remainingSlots === null ? null : Math.max(0, node.remainingSlots - 1),
        }
      : null,
  };
}

export async function createAppSale(
  env: Env,
  actor: SalesActor,
  input: AppSaleInput & { requestKey: string },
  now: number,
): Promise<{ accountId: string; state: string }> {
  validateSale(input);
  const accountInput: AccountInput = {
    nodeId: input.nodeId,
    kind: "sale",
    label: input.label,
    quotaBytes: input.quotaBytes,
    durationSeconds: input.durationSeconds,
    requestKey: input.requestKey,
  };
  const result = await createAccount(env.SALES_DB, actor, accountInput, now);
  return { accountId: result.id, state: result.state };
}

export async function createAppTrial(
  env: Env,
  actor: SalesActor,
  input: { nodeId: string; requestKey: string },
  now: number,
): Promise<{ accountId: string; state: string }> {
  if (
    typeof input.nodeId !== "string" ||
    !input.nodeId ||
    typeof input.requestKey !== "string" ||
    !input.requestKey ||
    input.requestKey.length > 120
  )
    throw Error("INVALID_ACCOUNT");
  const result = await createAccount(
    env.SALES_DB,
    actor,
    {
      nodeId: input.nodeId,
      kind: "trial",
      label: "تست نیم‌ساعته",
      quotaBytes: 1e9,
      durationSeconds: 1800,
      requestKey: input.requestKey,
    },
    now,
  );
  return { accountId: result.id, state: result.state };
}

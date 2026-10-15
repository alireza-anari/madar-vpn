import { admin, type Actor } from "./contracts";
export async function savePlan(
  db: D1Database,
  actor: Actor,
  input: {
    id: string;
    name: string;
    price: number;
    duration: number;
    currency: string;
    enabled: boolean;
  },
  now: number,
) {
  admin(actor);
  if (
    !/^[a-zA-Z0-9_-]{1,40}$/.test(input.id) ||
    !input.name.trim() ||
    input.name.length > 80 ||
    !Number.isSafeInteger(input.price) ||
    input.price < 1 ||
    !Number.isSafeInteger(input.duration) ||
    input.duration < 60 ||
    input.duration > 31536000 ||
    !["IRR", "IRT"].includes(input.currency)
  )
    throw new Error("INVALID_PLAN");
  await db.batch([
    db
      .prepare(
        "INSERT INTO plans(id,name,price,duration,currency,enabled) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,duration=excluded.duration,currency=excluded.currency,enabled=excluded.enabled",
      )
      .bind(
        input.id,
        input.name,
        input.price,
        input.duration,
        input.currency,
        input.enabled ? 1 : 0,
      ),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'save_plan',?,?)",
      )
      .bind(actor.telegramId, input.id, now),
  ]);
}
export async function savePayment(
  db: D1Database,
  actor: Actor,
  value: string,
  now: number,
) {
  admin(actor);
  if (!value.trim() || value.length > 1000) throw new Error("INVALID_PAYMENT");
  await db.batch([
    db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('payment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .bind(value),
    db
      .prepare(
        "INSERT INTO audit_events(actor_id,action,target_id,created_at) VALUES(?,'save_payment','payment',?)",
      )
      .bind(actor.telegramId, now),
  ]);
}

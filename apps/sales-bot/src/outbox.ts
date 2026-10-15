export async function deliverOutbox(
  env: Env,
  now: number,
  fetcher: typeof fetch = fetch,
) {
  if (!env.BOT_TOKEN) return;
  const rows = await env.SALES_DB.prepare(
    "SELECT * FROM outbox WHERE state='pending' AND available_at<=? AND lease_until<=? ORDER BY available_at LIMIT 10",
  )
    .bind(now, now)
    .all<{ id: string; chat_id: string; payload: string; attempts: number }>();
  for (const row of rows.results) {
    const lease = await env.SALES_DB.prepare(
      "UPDATE outbox SET lease_until=? WHERE id=? AND state='pending' AND lease_until<=?",
    )
      .bind(now + 60, row.id, now)
      .run();
    if (!lease.meta.changes) continue;
    let ok = false,
      permanent = false,
      retryAfter = 0;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const method =
        payload._method === "sendDocument"
          ? "sendDocument"
          : payload._method === "sendPhoto"
            ? "sendPhoto"
            : "sendMessage";
      delete payload._method;
      const r = await fetcher(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: row.chat_id, ...payload }),
          signal: AbortSignal.timeout(10000),
        },
      );
      const data: unknown = await r.json();
      ok =
        r.ok &&
        typeof data === "object" &&
        data !== null &&
        "ok" in data &&
        data.ok === true;
      permanent = r.status === 400 || r.status === 403;
      if (
        typeof data === "object" &&
        data !== null &&
        "parameters" in data &&
        typeof data.parameters === "object" &&
        data.parameters !== null &&
        "retry_after" in data.parameters
      )
        retryAfter = Number(data.parameters.retry_after) || 0;
    } catch {
      /* Do not log fetch errors containing bot token URLs. */
    }
    await env.SALES_DB.prepare(
      "UPDATE outbox SET state=?,attempts=attempts+1,available_at=?,lease_until=0 WHERE id=?",
    )
      .bind(
        ok ? "sent" : permanent || row.attempts >= 9 ? "dead" : "pending",
        now +
          Math.max(retryAfter, Math.min(3600, 2 ** (row.attempts + 1) * 10)),
        row.id,
      )
      .run();
  }
}

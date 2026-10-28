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
        payload._method === "deleteMessage"
          ? "deleteMessage"
          : payload._method === "sendDocument"
          ? "sendDocument"
          : payload._method === "sendPhoto"
            ? "sendPhoto"
            : payload._method === "editMessageText"
              ? "editMessageText"
              : "sendMessage";
      delete payload._method;
      const call = async (action:string,body:Record<string,unknown>) => {
        const response = await fetcher(`https://api.telegram.org/bot${env.BOT_TOKEN}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: row.chat_id, ...body }),
          signal: AbortSignal.timeout(10000),
        });
        const result: unknown = await response.json();
        return {response,result};
      };
      let {response,result} = await call(method,payload);
      if(method==="editMessageText" && response.status===400) {
        const description=typeof result==="object" && result!==null && "description" in result
          ? String(result.description) : "";
        if(description.toLowerCase().includes("message is not modified")) {
          ok=true;
        } else {
          // Old/deleted/uneditable callback messages must never discard the customer's action.
          // Fall back to sending a normal message without message_id.
          const {message_id:_ignored,...messagePayload}=payload;
          ({response,result}=await call("sendMessage",messagePayload));
        }
      }
      if(!ok) ok=response.ok && typeof result==="object" && result!==null &&
        "ok" in result && result.ok===true;
      permanent=!ok && (response.status===400 || response.status===403);
      if (typeof result==="object" && result!==null && "parameters" in result &&
        typeof result.parameters==="object" && result.parameters!==null &&
        "retry_after" in result.parameters) retryAfter=Number(result.parameters.retry_after)||0;
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

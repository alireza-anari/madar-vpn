/** Temporary, IP-restricted operational pairing; removed after Runner enrollment. */
export async function bootstrapPair(
  request: Request,
  env: Env,
  now: number,
  deadline: number,
): Promise<Response> {
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (now >= deadline) return reply({ error: "PAIRING_EXPIRED" }, 410);
  if (
    request.method !== "POST" ||
    request.headers.get("CF-Connecting-IP") !== "56.228.6.3"
  )
    return reply({ error: "FORBIDDEN" }, 403);
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "INVALID_IDENTITY" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        return reply({ error: "TOO_LARGE" }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const j = input.publicKey;
    if (
      !j ||
      j.kty !== "RSA" ||
      j.e !== "AQAB" ||
      typeof j.n !== "string" ||
      j.n.length !== 512 ||
      !/^[A-Za-z0-9_-]+$/.test(j.n) ||
      j.d
    )
      return reply({ error: "INVALID_IDENTITY" }, 400);
    const publicKey = {
      kty: "RSA",
      n: j.n,
      e: "AQAB",
      alg: "RSA-OAEP-256",
      ext: true,
      key_ops: ["encrypt"],
    };
    await crypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const canonical = JSON.stringify(publicKey, Object.keys(publicKey).sort());
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    if (input.fingerprint !== fingerprint)
      return reply({ error: "INVALID_IDENTITY" }, 400);
    await env.SALES_DB.prepare(
      "INSERT OR IGNORE INTO settings(key,value) VALUES('runner_bootstrap_candidate',?)",
    )
      .bind(JSON.stringify({ publicKey, fingerprint, at: now }))
      .run();
    const candidate = await env.SALES_DB.prepare(
      "SELECT value FROM settings WHERE key='runner_bootstrap_candidate'",
    ).first<string>("value");
    if (!candidate || JSON.parse(candidate).fingerprint !== fingerprint)
      return reply({ error: "IDENTITY_ALREADY_PINNED" }, 409);
    const sealed = await env.SALES_DB.prepare(
      "SELECT value FROM settings WHERE key='runner_bootstrap_envelope'",
    ).first<string>("value");
    if (sealed) {
      const result = JSON.parse(sealed);
      if (result.fingerprint === fingerprint)
        return reply({ envelope: result.envelope });
    }
    return reply({ pending: true, fingerprint });
  } catch {
    return reply({ error: "INVALID_IDENTITY" }, 400);
  }
}

import QRCode from "qrcode";
import { customerConfig } from "./customer-store";
import { resolveSalesActor } from "./resellers";

type QrPayload = { u: string; o: string; e: number };
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {\n  const copy = new Uint8Array(bytes.length);\n  copy.set(bytes);\n  return copy.buffer as ArrayBuffer;\n}\nfunction decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 2048) throw Error("INVALID_TOKEN");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("madar-customer-qr-v1:" + message)));
}
export async function createCustomerQrUrl(env: Env, userId: string, orderId: string, now: number) {
  if (!env.USAGE_LINK_SECRET || !env.PUBLIC_BASE_URL || !/^\d{1,16}$/.test(userId) ||
    !/^[a-f0-9-]{36}$/.test(orderId)) throw Error("QR_UNAVAILABLE");
  const payload: QrPayload = { u: userId, o: orderId, e: now + 600 };
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = base64url(await hmac(env.USAGE_LINK_SECRET, encoded));
  return new URL("/api/customer/qr/" + encoded + "." + signature, env.PUBLIC_BASE_URL).toString();
}
export async function customerQrResponse(request: Request, env: Env, token: string, now: number): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  if (request.method !== "GET" || !env.USAGE_LINK_SECRET) return notFound();
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return notFound();
    const [encoded, signature] = parts as [string, string];
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64url(encoded))) as Partial<QrPayload>;
    if (typeof payload.u !== "string" || !/^\d{1,16}$/.test(payload.u) ||
      typeof payload.o !== "string" || !/^[a-f0-9-]{36}$/.test(payload.o) ||
      typeof payload.e !== "number" || !Number.isSafeInteger(payload.e) ||
      payload.e <= now || payload.e > now + 600) return notFound();
    const key = await crypto.subtle.importKey("raw", encoder.encode(env.USAGE_LINK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, toArrayBuffer(decodeBase64url(signature)), encoder.encode("madar-customer-qr-v1:" + encoded));
    if (!valid) return notFound();
    const actor = await resolveSalesActor(env.SALES_DB, payload.u, env);
    if (actor.role !== "ordinary") return notFound();
    const result = await customerConfig(env, actor, payload.o, now);
    if (!result.ready || typeof result.config !== "string" || !result.config.startsWith("vless://")) return notFound();
    const png = await QRCode.toBuffer(result.config, { errorCorrectionLevel: "M", margin: 2, width: 640 });
    return new Response(png as unknown as BodyInit, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return notFound();
  }
}

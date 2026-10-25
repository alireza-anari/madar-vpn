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
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}
function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 2048) throw Error("INVALID_TOKEN");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
function u32(value: number) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}
function concatBytes(parts: Uint8Array[]) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = encoder.encode(type);
  const crcInput = concatBytes([typeBytes, data]);
  return concatBytes([u32(data.length), typeBytes, data, u32(crc32(crcInput))]);
}
async function renderQrPng(value: string) {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const margin = 4;
  const scale = Math.max(3, Math.floor(640 / (qr.modules.size + margin * 2)));
  const width = (qr.modules.size + margin * 2) * scale;
  const raw = new Uint8Array((width + 1) * width);
  for (let y = 0; y < width; y++) {
    const row = y * (width + 1);
    raw[row] = 0;
    const moduleY = Math.floor(y / scale) - margin;
    for (let x = 0; x < width; x++) {
      const moduleX = Math.floor(x / scale) - margin;
      const dark = moduleX >= 0 && moduleY >= 0 && moduleX < qr.modules.size && moduleY < qr.modules.size &&
        qr.modules.data[moduleY * qr.modules.size + moduleX] === 1;
      raw[row + 1 + x] = dark ? 0 : 255;
    }
  }
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  await writer.write(raw);
  await writer.close();
  const compressed = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  const header = new Uint8Array(13);
  header.set(u32(width), 0);
  header.set(u32(width), 4);
  header[8] = 8; // 8-bit grayscale
  header[9] = 0; // grayscale
  const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concatBytes([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
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
    const png = await renderQrPng(result.config);
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

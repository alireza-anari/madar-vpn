import { isIP } from "node:net";
export function publicTarget(ip: string) {
  if (isIP(ip) === 4) {
    const a = ip.split(".").map(Number);
    const x = a[0]!,
      y = a[1]!,
      z = a[2]!;
    if (
      x === 0 ||
      x === 10 ||
      x === 127 ||
      x >= 224 ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || y === 0 || y === 2)) ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) ||
      (x === 203 && y === 0 && z === 113)
    )
      throw new Error("INVALID_TARGET");
    return ip;
  }
  if (isIP(ip) === 6) {
    const first = Number.parseInt(ip.split(":")[0] || "0", 16);
    if (
      first < 0x2000 ||
      first > 0x3fff ||
      /^2001:/i.test(ip) ||
      /^2002:/i.test(ip) ||
      /^3fff:/i.test(ip)
    )
      throw new Error("INVALID_TARGET");
    return ip.toLowerCase();
  }
  throw new Error("INVALID_TARGET");
}
export function validatePort(port: number) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("INVALID_PORT");
}

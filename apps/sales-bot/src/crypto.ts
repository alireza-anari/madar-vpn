import { createHash, createHmac } from "node:crypto";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const sign = (key: string, value: string) =>
  createHmac("sha256", key).update(value).digest("hex");

import { describe, it, expect } from "vitest";
import worker from "../src/index";

describe("official brand logo", () => {
  it("serves the official PNG with safe image headers", async () => {
    const r = await worker.fetch(new Request("https://madar.test/madar-logo.png"), {} as Env);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(bytes.length).toBe(1785282);
    expect(Array.from(bytes.slice(0, 8))).toEqual([137,80,78,71,13,10,26,10]);
  });
});

import { expect, test } from "vitest";
import {
  buildVlessRealityConfig,
  parseVlessRealityConfig,
} from "../src/connection-config";

const base = {
  uuid: "11111111-1111-4111-8111-111111111111",
  host: "8.8.8.8",
  port: 443,
  sni: "www.cloudflare.com",
  publicKey: "A".repeat(43),
  shortId: "1234567890abcdef",
  flow: "" as const,
  label: "Madar-111111",
};

const withQueryParameter = (value: string, parameter: string) => {
  const fragment = value.indexOf("#");
  return fragment < 0
    ? value + "&" + parameter
    : value.slice(0, fragment) + "&" + parameter + value.slice(fragment);
};

test("builds one canonical TCP/REALITY VLESS URI and omits empty Flow", () => {
  const value = buildVlessRealityConfig(base);
  const parsed = parseVlessRealityConfig(value);
  const url = new URL(value);

  expect(parsed).toEqual({
    uuid: base.uuid,
    host: base.host,
    port: 443,
    sni: base.sni,
    publicKey: base.publicKey,
    shortId: base.shortId,
    flow: "",
  });
  expect(url.protocol).toBe("vless:");
  expect(url.searchParams.get("encryption")).toBe("none");
  expect(url.searchParams.get("security")).toBe("reality");
  expect(url.searchParams.get("type")).toBe("tcp");
  expect(url.searchParams.get("fp")).toBe("chrome");
  expect(url.searchParams.has("flow")).toBe(false);
});

test("adds Vision only when the account's pinned Flow explicitly requests it", () => {
  const value = buildVlessRealityConfig({
    ...base,
    flow: "xtls-rprx-vision",
  });
  expect(parseVlessRealityConfig(value).flow).toBe("xtls-rprx-vision");
  expect(new URL(value).searchParams.getAll("flow")).toEqual([
    "xtls-rprx-vision",
  ]);
});

test("brackets IPv6 endpoints correctly for URI importers", () => {
  const value = buildVlessRealityConfig({
    ...base,
    host: "2606:4700:4700::1111",
  });
  expect(value).toContain("@[2606:4700:4700::1111]:443?");
  expect(parseVlessRealityConfig(value).host).toBe(
    "2606:4700:4700::1111",
  );
});

test("rejects private or malformed endpoints instead of issuing a dead config", () => {
  expect(() =>
    buildVlessRealityConfig({ ...base, host: "127.0.0.1" }),
  ).toThrow("INVALID_VLESS_REALITY_CONFIG");
  expect(() =>
    buildVlessRealityConfig({ ...base, host: "not-an-ip.example" }),
  ).toThrow("INVALID_VLESS_REALITY_CONFIG");
});

test("rejects invalid UUID, port, SNI, public key, short ID, Flow and label", () => {
  const invalid = [
    { ...base, uuid: "not-a-uuid" },
    { ...base, port: 70000 },
    { ...base, sni: "https://example.com/path" },
    { ...base, publicKey: "not-a-reality-key" },
    { ...base, shortId: "xyz" },
    { ...base, flow: "vision" as never },
    { ...base, label: "bad label with spaces" },
  ];
  for (const input of invalid) {
    expect(() => buildVlessRealityConfig(input)).toThrow(
      "INVALID_VLESS_REALITY_CONFIG",
    );
  }
});

test("parser rejects duplicate, empty and unknown query parameters", () => {
  const value = buildVlessRealityConfig(base);
  expect(() =>
    parseVlessRealityConfig(withQueryParameter(value, "flow=")),
  ).toThrow("INVALID_VLESS_REALITY_CONFIG");
  expect(() =>
    parseVlessRealityConfig(
      withQueryParameter(
        value,
        "flow=xtls-rprx-vision&flow=xtls-rprx-vision",
      ),
    ),
  ).toThrow("INVALID_VLESS_REALITY_CONFIG");
  expect(() =>
    parseVlessRealityConfig(withQueryParameter(value, "alpn=h2")),
  ).toThrow("INVALID_VLESS_REALITY_CONFIG");
});

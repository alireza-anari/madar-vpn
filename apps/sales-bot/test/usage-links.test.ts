import { expect, test } from "vitest";
import { createUsageToken, verifyUsageToken, usageUrl } from "../src/usage-links";

const secret = "usage-secret-for-tests-1234567890";

test("usage token is deterministic, URL-safe and round-trips the account id", () => {
  const a = createUsageToken(secret, "account-123");
  const b = createUsageToken(secret, "account-123");
  expect(a).toBe(b);
  expect(a).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(verifyUsageToken(secret, a)).toBe("account-123");
});

test("usage token rejects tampering, wrong secret and malformed input", () => {
  const token = createUsageToken(secret, "account-123");
  expect(verifyUsageToken("other-secret", token)).toBeNull();
  expect(verifyUsageToken(secret, token.replace(/.$/, token.endsWith("A") ? "B" : "A"))).toBeNull();
  expect(verifyUsageToken(secret, "v2.bad")).toBeNull();
  expect(verifyUsageToken(secret, "x." + token)).toBeNull();
});

test("usage URL is regenerated from the canonical public base URL", () => {
  expect(
    usageUrl(
      { PUBLIC_BASE_URL: "https://example.test/", USAGE_LINK_SECRET: secret },
      "account-123",
    ),
  ).toMatch(/^https:\/\/example\.test\/usage\/v2\/v2\./);
});

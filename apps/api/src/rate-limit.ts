export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function consumeRateLimit(
  binding: RateLimitBinding | undefined,
  scope: string,
  sensitiveValue: string,
): Promise<boolean> {
  if (!binding) return true;
  const key = `${scope}:${await sha256Hex(sensitiveValue)}`;
  const result = await binding.limit({ key });
  return result.success;
}

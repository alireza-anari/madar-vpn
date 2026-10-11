import { describe, expect, it } from 'vitest';
import v2rayNgFixture from '../../../../tests/fixtures/v2rayng-2.2.6-reality-tcp.json';
import { renderSubscription } from './subscription';

describe('v2rayNG 2.2.6 compatibility fixture', () => {
  it('freezes the exact sanitized VLESS TCP REALITY share-link shape accepted in Phase 8', () => {
    const rendered = renderSubscription(v2rayNgFixture.profile, [v2rayNgFixture.node]);

    expect(rendered).toBe(v2rayNgFixture.expectedShareLink);

    const parsed = new URL(rendered);
    expect(parsed.protocol).toBe('vless:');
    expect(parsed.username).toBe(v2rayNgFixture.profile.clientUuid);
    expect(parsed.hostname).toBe(v2rayNgFixture.node.address);
    expect(parsed.port).toBe(String(v2rayNgFixture.node.port));
    expect(decodeURIComponent(parsed.hash.slice(1))).toBe(v2rayNgFixture.node.name);

    const queryEntries = [...parsed.searchParams.entries()];
    expect(queryEntries.map(([key]) => key)).toEqual(v2rayNgFixture.expected.queryParameterNames);
    expect(Object.fromEntries(queryEntries)).toEqual(v2rayNgFixture.expected.query);
    expect(rendered).not.toMatch(/private.?key|subscription.?token|node.?credential|internal.?user|email/i);
  });
});

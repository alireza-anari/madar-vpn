// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('PWA assets', () => {
  it('declares an installable Persian standalone manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'),
    ) as {
      name: string;
      short_name: string;
      dir: string;
      lang: string;
      display: string;
      start_url: string;
      icons: Array<{ src: string; purpose?: string }>;
    };

    expect(manifest.name).toBe('مدار');
    expect(manifest.short_name).toBe('مدار');
    expect(manifest.dir).toBe('rtl');
    expect(manifest.lang).toBe('fa');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('never runtime-caches API, auth, or subscription-secret requests', () => {
    const sw = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

    expect(sw).toContain("'/api/'");
    expect(sw).toContain("'/s/'");
    expect(sw).toContain("'/auth/'");
    expect(sw).toMatch(/request\.method\s*!==\s*['"]GET['"]/);
    expect(sw).toContain('isSensitiveRequest');
  });
});

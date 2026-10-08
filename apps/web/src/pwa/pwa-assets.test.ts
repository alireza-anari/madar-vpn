// @vitest-environment node

import { describe, expect, it } from 'vitest';
import manifestRaw from '../../public/manifest.webmanifest?raw';
import serviceWorker from '../../public/sw.js?raw';

describe('PWA assets', () => {
  it('declares an installable Persian standalone manifest', () => {
    const manifest = JSON.parse(manifestRaw) as {
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
    expect(serviceWorker).toContain("'/api/'");
    expect(serviceWorker).toContain("'/s/'");
    expect(serviceWorker).toContain("'/auth/'");
    expect(serviceWorker).toMatch(/request\.method\s*!==\s*['"]GET['"]/);
    expect(serviceWorker).toContain('isSensitiveRequest');
  });
});

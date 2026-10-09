import { describe, expect, it } from 'vitest';
import { createQrMatrix, createQrSvgDataUri } from './qr';

const value = 'https://app.example.test/s/bearer-subscription-secret';

function fnv1a32(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

describe('local subscription QR encoder', () => {
  it('matches the fixed QR version 10-L mask-0 golden matrix', () => {
    const matrix = createQrMatrix(value);
    expect(matrix).toHaveLength(57);
    expect(matrix.every((row) => row.length === 57)).toBe(true);
    const serialized = matrix.flat().map((module) => module ? '1' : '0').join('');
    expect(fnv1a32(serialized)).toBe(0x79780177);
  });

  it('renders a local SVG data URI without embedding the bearer URL as text', () => {
    const uri = createQrSvgDataUri(value);
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('<svg');
    expect(svg).not.toContain(value);
    expect(svg).not.toContain('http');
  });

  it('rejects values that exceed the supported byte capacity instead of truncating them', () => {
    expect(() => createQrMatrix('x'.repeat(272))).toThrow(/271/);
  });
});

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mobile shell layout guard', () => {
  it('clips accidental horizontal overflow and constrains the shell to the viewport', () => {
    const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

    expect(css).toMatch(/overflow-x:\s*clip/);
    expect(css).toMatch(/\.app-shell[\s\S]*max-width:\s*100%/);
    expect(css).not.toMatch(/min-width:\s*(?:[4-9]\d{2}|\d{4,})px/);
  });

  it('keeps admin surface grids single-column on mobile and expands them only at desktop breakpoints', () => {
    const css = readFileSync(new URL('./surfaces.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.surface-grid--two,\s*\.surface-grid--three\s*{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media\s*\(min-width:\s*44rem\)[\s\S]*?\.surface-grid--two[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media\s*\(min-width:\s*68rem\)[\s\S]*?\.surface-grid--three[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  });
});

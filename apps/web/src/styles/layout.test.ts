// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mobile shell layout guard', () => {
  it('clips accidental horizontal overflow, constrains the shell, and reserves mobile safe areas', () => {
    const globalCss = readFileSync(new URL('./global.css', import.meta.url), 'utf8');
    const neonCss = readFileSync(new URL('./neon.css', import.meta.url), 'utf8');
    const css = `${globalCss}\n${neonCss}`;

    expect(css).toMatch(/overflow-x:\s*clip/);
    expect(css).toMatch(/\.app-shell[\s\S]*max-width:\s*100%/);
    expect(css).not.toMatch(/min-width:\s*(?:[4-9]\d{2}|\d{4,})px/);
    expect(neonCss).toMatch(/safe-area-inset-bottom/);
    expect(neonCss).toMatch(/\.bottom-nav[\s\S]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('keeps admin surface grids single-column on mobile and expands them only at desktop breakpoints', () => {
    const css = readFileSync(new URL('./surfaces.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.surface-grid--two,\s*\.surface-grid--three\s*{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media\s*\(min-width:\s*44rem\)[\s\S]*?\.surface-grid--two[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media\s*\(min-width:\s*68rem\)[\s\S]*?\.surface-grid--three[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  });
});

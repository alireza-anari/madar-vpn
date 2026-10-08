// @vitest-environment node

import { describe, expect, it } from 'vitest';
import css from './global.css?inline';

describe('mobile shell layout guard', () => {
  it('clips accidental horizontal overflow and constrains the shell to the viewport', () => {
    expect(css).toMatch(/overflow-x:\s*clip/);
    expect(css).toMatch(/\.app-shell[\s\S]*max-width:\s*100%/);
    expect(css).not.toMatch(/min-width:\s*(?:[4-9]\d{2}|\d{4,})px/);
  });
});

import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../components/AppShell';
import './global.css';

describe('mobile shell layout guard', () => {
  it('clips accidental horizontal overflow and constrains the shell to the viewport', () => {
    const { container } = render(
      createElement(AppShell, { serviceStatus: 'checking' }, createElement('div')),
    );

    const shell = container.firstElementChild;
    expect(shell).not.toBeNull();
    expect(getComputedStyle(document.body).overflowX).toBe('clip');
    expect(getComputedStyle(shell as Element).maxWidth).toBe('100%');
  });
});

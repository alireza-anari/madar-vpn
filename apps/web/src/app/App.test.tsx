import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('Madar web bootstrap', () => {
  it('renders the Persian product identity in an RTL root', () => {
    const { container } = render(<App />);
    expect(screen.getByText('مدار')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('dir', 'rtl');
  });
});

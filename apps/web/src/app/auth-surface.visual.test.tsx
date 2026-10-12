import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractiveLoginPage } from './auth-surface';

afterEach(() => cleanup());

describe('neon login surface', () => {
  it('renders the approved Madar identity and secure magic-link structure without a fake guest action', () => {
    render(<InteractiveLoginPage emailAvailable requestLogin={vi.fn(async () => 'sent')} />);

    expect(screen.getByText('مدار')).toBeInTheDocument();
    expect(screen.getByText('اتصال آزادتر، زندگی بزرگ‌تر')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /ورود امن و ساده/ })).toBeInTheDocument();
    expect(screen.getByText(/لینک ورود یک‌بار مصرف است/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /مهمان/ })).not.toBeInTheDocument();

    const email = screen.getByRole('textbox', { name: /ایمیل/ });
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(email).toHaveAttribute('dir', 'ltr');
    expect(email).toHaveAttribute('placeholder', 'name@example.com');
  });

  it('preserves the real sent status semantics after submit', async () => {
    const requestLogin = vi.fn(async () => 'sent' as const);
    render(<InteractiveLoginPage emailAvailable requestLogin={requestLogin} />);

    const email = screen.getByRole('textbox', { name: /ایمیل/ });
    fireEvent.change(email, { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /ارسال لینک ورود/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('لینک ورود ارسال شد');
  });

  it('preserves the real unavailable status semantics', () => {
    render(<InteractiveLoginPage emailAvailable={false} />);

    expect(screen.getByRole('button', { name: /ارسال لینک ورود/ })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('سرویس ایمیل هنوز متصل نشده');
  });
});

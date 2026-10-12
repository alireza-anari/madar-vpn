import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InteractiveLoginPage } from './auth-surface';

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

  it('preserves real submit and unavailable status semantics', async () => {
    const requestLogin = vi.fn(async () => 'sent' as const);
    const { rerender } = render(<InteractiveLoginPage emailAvailable requestLogin={requestLogin} />);

    const email = screen.getByRole('textbox', { name: /ایمیل/ });
    fireEvent.change(email, { target: { value: 'user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /ارسال لینک ورود/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('لینک ورود ارسال شد');

    rerender(<InteractiveLoginPage emailAvailable={false} />);
    expect(screen.getByRole('button', { name: /ارسال لینک ورود/ })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('سرویس ایمیل هنوز متصل نشده');
  });
});

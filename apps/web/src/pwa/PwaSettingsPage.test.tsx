import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PwaSettingsPage } from './PwaSettingsPage';

describe('PWA settings UX', () => {
  it('requests notification permission only after an explicit user click', async () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const subscribe = vi.fn(async () => true);

    render(
      <PwaSettingsPage
        pushAvailable
        notificationSupported
        requestPermission={requestPermission}
        subscribe={subscribe}
      />,
    );

    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /فعال‌کردن اعلان/ }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
  });

  it('keeps install help usable when notifications are denied or unsupported', async () => {
    const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
    const subscribe = vi.fn(async () => true);
    const installPrompt = vi.fn(async () => undefined);

    const { rerender } = render(
      <PwaSettingsPage
        pushAvailable
        notificationSupported
        requestPermission={requestPermission}
        subscribe={subscribe}
        installPrompt={installPrompt}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /فعال‌کردن اعلان/ }));
    await screen.findByText(/مجوز اعلان داده نشد/);
    expect(subscribe).not.toHaveBeenCalled();
    expect(screen.getByText(/نصب روی iPhone/)).toBeInTheDocument();
    expect(screen.getByText(/افزودن به صفحه اصلی/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /نصب برنامه/ }));
    await waitFor(() => expect(installPrompt).toHaveBeenCalledTimes(1));

    rerender(
      <PwaSettingsPage
        pushAvailable
        notificationSupported={false}
        requestPermission={requestPermission}
        subscribe={subscribe}
      />,
    );
    expect(screen.getByText(/اعلان در این مرورگر پشتیبانی نمی‌شود/)).toBeInTheDocument();
    expect(screen.getByText(/نصب روی iPhone/)).toBeInTheDocument();
  });

  it('does not request permission when browser subscription persistence is not wired', () => {
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);

    render(
      <PwaSettingsPage
        pushAvailable
        notificationSupported
        requestPermission={requestPermission}
      />,
    );

    expect(screen.getByRole('button', { name: /فعال‌کردن اعلان/ })).toBeDisabled();
    expect(screen.getByText(/فعال‌سازی این دستگاه هنوز به نشست امن متصل نشده/)).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('captures the Android beforeinstallprompt event and prompts only after a click', async () => {
    const prompt = vi.fn(async () => undefined);
    const installEvent = new Event('beforeinstallprompt');
    Object.assign(installEvent, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });

    render(<PwaSettingsPage pushAvailable={false} notificationSupported={false} />);
    window.dispatchEvent(installEvent);

    const button = await screen.findByRole('button', { name: /نصب برنامه/ });
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });
});

import type { MagicLinkMessage } from './index';

type DeliveryStatus = 'sent' | 'unavailable';
type ResendFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ResendMagicLinkConfig = Readonly<{
  apiKey: string;
  from: string;
  baseUrl: string;
  allowedEmails: readonly string[];
  fetcher?: ResendFetcher;
}>;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createMagicLink(baseUrl: string, token: string) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('Magic-link origin must use HTTPS.');
  const link = new URL('/login', base);
  link.hash = new URLSearchParams({ token }).toString();
  return link.toString();
}

export function createResendMagicLinkSender(config: ResendMagicLinkConfig) {
  const apiKey = config.apiKey.trim();
  const from = config.from.trim();
  const baseUrl = config.baseUrl.trim();
  const allowedEmails = new Set(config.allowedEmails.map(normalizeEmail).filter(Boolean));
  const fetcher: ResendFetcher = config.fetcher ?? ((input, init) => fetch(input, init));

  return async (message: MagicLinkMessage): Promise<DeliveryStatus> => {
    const email = normalizeEmail(message.email);
    if (!apiKey || !from || !baseUrl || !allowedEmails.has(email)) return 'unavailable';

    let magicLink: string;
    try {
      magicLink = createMagicLink(baseUrl, message.token);
    } catch {
      return 'unavailable';
    }

    const escapedLink = escapeHtml(magicLink);
    const escapedExpiry = escapeHtml(message.expiresAt);
    try {
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'ورود به مدار',
          text: `برای ورود به مدار این لینک را باز کنید:\n${magicLink}\n\nاین لینک تا ${message.expiresAt} معتبر است.`,
          html: `<p dir="rtl">برای ورود به مدار روی لینک زیر بزنید:</p><p><a href="${escapedLink}">${escapedLink}</a></p><p dir="rtl">اعتبار لینک تا ${escapedExpiry} است.</p>`,
        }),
      });
      return response.ok ? 'sent' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
}

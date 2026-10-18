// These bindings are configured on the production Worker in Cloudflare.
// They are intentionally absent from wrangler.jsonc so that Wrangler's
// keep_vars setting preserves existing deployment values on upload.
// Keep this declaration synchronized with the expected Worker bindings;
// never place production values or secrets in source control.
declare global {
  interface Env {
    ADMIN_TELEGRAM_IDS: string;
    PUBLIC_BASE_URL: string;
    RUNNER_PUBLIC_KEY: string;
  }

  namespace Cloudflare {
    interface Env {
      ADMIN_TELEGRAM_IDS: string;
      PUBLIC_BASE_URL: string;
      RUNNER_PUBLIC_KEY: string;
    }
  }
}

export {};

import { verifyMiniApp } from "./miniapp-auth";
import {
  enrollmentJobStatus,
  createEnrollment,
  createProbe,
  issueNonce,
  type EnrollmentInput,
} from "./enrollment";
import { boundedText } from "./auth";
export async function adminApi(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  try {
    const actor = await verifyMiniApp(
      request.headers.get("X-Telegram-Init-Data") || "",
      env,
      now,
    );
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/session" && request.method === "GET")
      return Response.json({
        nonce: await issueNonce(env.SALES_DB, actor, now),
        publicKey: env.RUNNER_PUBLIC_KEY
          ? JSON.parse(env.RUNNER_PUBLIC_KEY)
          : null,
      });
    if (path.startsWith("/api/admin/jobs/") && request.method === "GET") {
      const row = await enrollmentJobStatus(
        env.SALES_DB,
        path.split("/").at(-1)!,
        actor.telegramId,
        now,
      );
      return Response.json(row || { error: "NOT_FOUND" }, {
        status: row ? 200 : 404,
      });
    }
    if (request.method === "POST") {
      const input = JSON.parse(await boundedText(request, 24000));
      if (path === "/api/admin/probe")
        return Response.json(await createProbe(env, actor, input, now));
      if (path === "/api/admin/enroll")
        return Response.json(
          await createEnrollment(env, actor, input as EnrollmentInput, now),
        );
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  } catch (error) {
    const known = [
      "ADMIN_REQUIRED",
      "INVALID_SIGNATURE",
      "AUTH_EXPIRED",
      "NONCE_REPLAY",
      "INVALID_TARGET",
      "INVALID_PORT",
      "INVALID_INPUT",
      "INVALID_CAPACITY",
      "INVALID_ALLOCATION_CAP",
      "EXISTING_NODE",
      "FINGERPRINT_UNCONFIRMED",
      "INVALID_CIPHERTEXT",
    ];
    const code = error instanceof Error ? error.message : "";
    return Response.json(
      { error: known.includes(code) ? code : "REQUEST_FAILED" },
      {
        status: [
          "ADMIN_REQUIRED",
          "INVALID_SIGNATURE",
          "AUTH_EXPIRED",
        ].includes(code)
          ? 403
          : 400,
      },
    );
  }
}

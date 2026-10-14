# Task 33 Web Push continuation

Baseline: `ea0fa64308e9d17703973281c933c0a324ef811d`.
Branch: `impl/phase-10-task33-pwa-push`.
Authority: approved clean-start design, existing Task 33/34 plan and the operator's detailed 2026-10-14 execution instructions.

Implement inline under TDD. The requested existing VAPID boundary remains unchanged. Use Worker Web Crypto and Fetch without a dependency: RFC 8291/8188 encryption, RFC 8292 authentication. Validate key material, suppress provider bodies/errors, bound fetch duration, refuse redirects and constrain supported push-service hosts to prevent subscription-based SSRF. Retain private signing material only in runtime bindings. No frontend/install changes, resource changes or Premium identity invention.

1. Observe RED for encrypted delivery, HTTP expiry/failure, network errors, malformed configuration and private-only secret handling. Independently decrypt the wire body and verify JWT signature in Worker tests.
2. Implement transport and explicitly wire PostgreSQL runtime. Add observed RED runtime tests proving wiring and fail-closed availability without disabling other APIs. Verify GREEN.
3. Review branch; run frozen install, all suites/typecheck/build/security/audits and full exact-head CI including PostgreSQL and Go gates.
4. Configure staging only through authorized secret bindings; stop for explicit approval if browser secret mutation is needed. Deploy candidate and verify health. Collect one-step manual physical-device evidence, including versions, explicit permission, delivery/click and denied usability.
5. Audit prior Phase 7–10 reports. Execute every Task 34 required rerun on the final candidate when real environment access is available. Record each required item PASS/FAIL/BLOCKED. Do not promote release with any required blocker.

Completion requires real Android and iPhone evidence, configured provider callbacks and approved/implemented client-instance enforcement. Code tests alone do not complete Task 33/34.

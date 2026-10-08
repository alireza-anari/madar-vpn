# Madar PostgreSQL backup and restore

This runbook applies to the **authoritative PostgreSQL database** defined by the approved Madar architecture. D1 is not an acceptable substitute for this recovery procedure.

The CI recovery contract uses a disposable PostgreSQL database, creates a custom-format backup, destroys the test schema, restores it, and verifies witness account, credit-ledger, and application-setting data. A production restore remains a controlled operational action and must never be performed merely because the CI contract passes.

## Safety rules

- Treat every database backup as sensitive production data.
- Store backup files with owner-only permissions (`0600`) and encrypt them at rest using the approved storage/provider controls.
- Never commit a dump to Git, attach it to a ticket/chat, or place it in a public artifact store.
- Never print the database URL, password, backup contents, subscription bearer tokens, node credentials, or private-key material into logs.
- Keep the previous database/snapshot available until post-restore validation is complete.
- Test a backup by restoring it into a fresh disposable/staging database before relying on it for recovery.
- A destructive production restore requires an explicit maintenance/change decision, a known target database, and a write-quiescence plan.

## Tool-version rule

`pg_dump` must not be older than the PostgreSQL server it backs up. Use PostgreSQL client tools matching the server major version. Madar CI currently proves the contract against PostgreSQL 17 by running backup/restore tools from the pinned `postgres:17` image.

Check the server version without echoing the connection string:

```bash
psql "$DATABASE_URL" -Atc 'SHOW server_version;'
```

Select the corresponding client image, for example:

```bash
export POSTGRES_MAJOR='17'
```

Do not hard-code a production password into the command or shell history. Supply `DATABASE_URL` through the deployment secret mechanism or a protected process environment.

## Create a logical backup

Create a private working directory and restrictive output file:

```bash
umask 077
backup_dir="$(mktemp -d)"
backup_file="$backup_dir/madar.dump"
```

Run matching PostgreSQL tools from an environment that can reach the database. The exact network option is deployment-specific; do not copy the CI `--network host` setting blindly into production.

Conceptual command:

```bash
docker run --rm \
  -e DATABASE_URL \
  "postgres:${POSTGRES_MAJOR}" \
  sh -c 'pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL"' \
  > "$backup_file"
chmod 600 "$backup_file"
```

Verify that the command succeeded and the backup is non-empty. Do not inspect it by printing data rows to shared logs.

## Validate by restoring to a disposable database

Create a fresh disposable/staging PostgreSQL database. Never validate restore by wiping production.

Set its connection URL through the protected environment as `RESTORE_DATABASE_URL`, then restore using the same PostgreSQL major line:

```bash
docker run --rm -i \
  -e RESTORE_DATABASE_URL \
  "postgres:${POSTGRES_MAJOR}" \
  sh -c 'pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL"' \
  < "$backup_file"
```

A successful `pg_restore` exit code is necessary but not sufficient. Continue with application-level validation.

## Post-restore validation

Confirm, without dumping sensitive values, that:

1. authoritative schema objects and migrations are present;
2. user/account counts are plausible for the recovery point;
3. the immutable credit ledger is present and internally consistent;
4. Premium/account entitlement state is present;
5. access-profile, client-credential, and subscription-token records preserve the expected hash/revocation model;
6. node metadata, policy state, health metadata, and audit records are present;
7. application settings such as the free speed limit survived;
8. the control-plane application can perform read-only account/admin smoke checks against the restored database;
9. no recovery step exposed raw subscription tokens, node credentials, REALITY private keys, or session secrets.

For CI, `tests/integration/postgres-backup-restore.sh` additionally proves that a seeded user, its 1,800-second ledger entry, and the default 5,000 kbps free-speed setting survive a destructive wipe-and-restore cycle on the disposable database.

## Production recovery sequence

1. Declare a maintenance/recovery window and stop or otherwise quiesce writes.
2. Identify the intended recovery point and retain the pre-restore database/snapshot.
3. Validate the chosen backup on a fresh database first.
4. Create a fresh production replacement database where possible instead of restoring in-place.
5. Restore with matching PostgreSQL tools and fail on the first restore error.
6. Run the post-restore validation checklist.
7. Point the control plane/Hyperdrive configuration at the recovered database only after validation.
8. Perform read-only smoke checks, then controlled write checks.
9. Resume normal writes and monitor errors, entitlement/account mutations, and node-control behavior.
10. Retain the rollback source until the recovery is formally accepted.

## Rollback

If validation fails, do not partially repair the recovered database in production. Keep it isolated, restore service to the last known-good database/snapshot, investigate the failed backup or migration path, and repeat the validation on a disposable database before another production attempt.

## Verified scope

The automated contract proves logical backup/restore behavior on a disposable PostgreSQL CI database. It does **not** prove provider-managed point-in-time recovery, production storage retention, a live Neon restore, or a production cutover. Those require environment-specific operational evidence.

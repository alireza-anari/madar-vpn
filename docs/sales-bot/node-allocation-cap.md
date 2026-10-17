# Node assigned-volume capacity

The owner sets two independent issuance limits: maximum simultaneously reserved accounts and maximum full assigned GB. A server with 20 slots and 1,000 GB stops at ten 100 GB accounts or twenty smaller accounts. Both conditions include the incoming request and are enforced in the same conditional INSERT, across every seller. Retries of the same seller/request return the existing account without reserving twice.

Preparing accounts reserve capacity immediately. Preparation with no activation expiry yet (valid_until=0) reserves; once an expiry exists it must still be in the future. Active unexpired nondepleted accounts reserve their full quota, even after partial consumption. Expired, revoked, blocked and exhausted accounts do not reserve. A test reserves 1 decimal GB like its account quota. An old uncapped account blocks new reservations on a finite-cap node until its reservation ends.

Enrollment requires an integer total of 1–1,000,000 decimal GB. The default shown in the form is 1,000 GB and can be changed. Migration 0009 leaves existing nodes NULL (uncapped) without inventing limits. Administrators can set limits under Servers → Volume cap. Reducing a limit below existing reservations prevents new issuance but does not disconnect or delete existing accounts. Sellers cannot change the limits.

The server picker and manager display available slots and assigned GB remaining. Values shown are a snapshot; final confirmation rechecks atomically. This is an allocation/sales limit, not a traffic cap or an AWS billing meter. No Python agent, Runner, signing protocol or shared-443 network behavior changes are involved.

Release: apply migration 0009 before deploying exact green Worker code; preserve bindings/secrets and scheduled triggers. Tests cover both owner examples, concurrent sellers, replay, partial consumption, terminal/expired preparation release, trial reservations, legacy uncapped accounts, finite enrollment and admin authorization. Shared-443 live field acceptance remains a separate pending rollout.

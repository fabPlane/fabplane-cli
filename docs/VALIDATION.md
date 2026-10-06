# Current-main PCB candidate validation — 2026-10-05

Prepared on official `fabPlane/fabplane-cli` main `c31b8fd` (version 0.3.0), preserving bot-connect, inventory photo queue, existing integrations and workflow changes. Proposed package version 0.3.1; unpublished. The older 0.1.1 isolated artifact is superseded and must not be published.

- 183 npm tests pass, zero failures/skips. All seven PCB SDK routes, strict updates, denial propagation, protocol schemas, CLI stdin and inherited bot/inventory/integration behavior are covered.
- Typecheck, build and offline schema synchronization pass; 62 operations have client methods. Existing spec paths are retained; only the seven PCB operations are added.
- Two real SDK/current-main API contract tests pass (10 assertions) on a disposable PostgreSQL database with PCB migration 0013. No hosted API or live data was written.
- Missing external SDK checkout skips only that optional cross-repository API suite instead of breaking backend CI. Explicit `PCB_SDK_CHECKOUT` selects this prepared CLI for integration checks.
- Existing organization authorization and bot confinement remain server-enforced. New MCP tools may resolve an explicitly configured default org, but do not grant access. Seven one-record/read/preview operations; no import apply, delete or bulk mutation.
- OpenClaw template remains disabled, supports preapproved isolated stored CLI credentials, and does not change host configuration or create tokens. No actual OpenClaw host import/update was run.

Package/host setup and release boundaries are described in `docs/openclaw-pcb.md`. The copied request/type snapshot remains from the API's canonical shared schema; the server owns persistence and preview reconciliation. Keep normal API spec auto-sync separate from this undeployed candidate.

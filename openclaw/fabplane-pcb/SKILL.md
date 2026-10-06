---
name: fabplane-pcb
description: Inspect and manage organization-scoped PCB boards, parallel revisions, blockers, and manufacturing orders with the fabplane CLI. Import is review-only.
metadata: {"openclaw":{"requires":{"bins":["fabplane"],"env":["FABPLANE_ORG"]}}}
---

Use the installed, reviewed fabplane-cli package (PCB support begins in the proposed 0.3.1 release).
Use preapproved stored CLI credentials via FABPLANE_CREDENTIALS_FILE (or an already authorized FABPLANE_TOKEN) and the explicit organization UUID in FABPLANE_ORG. Connection/approval is a separate human-authorized setup step; never perform it during a PCB agent turn.
Never print, copy, persist or send the token elsewhere. Do not log in, create/rotate
credentials, change permissions, invoke desktop tools, send messages or change live
OpenClaw configuration as part of PCB work.

Read first: `fabplane pcb list --json --org "$FABPLANE_ORG"`.
Describe board identities, revision stages, order observations, evidence dates,
open blocker reason/owner/next action/dependencies, and unknown fields separately.
A blocker is an overlay, not a stage. Shipment delivery is not physical receipt or function.
Never promote old progress/ETA or prototype examples into current verified status.

Preview reviewed local import evidence with:
`fabplane pcb import-preview reviewed-candidates.json --json --org "$FABPLANE_ORG"`.
The body is `{ "candidates": [{ "board": {...}, "revision": {...} }] }`.
This command never applies imports. Stop for mapping conflicts/review actions.

Only for an explicit user request identifying the intended record and change,
prepare and validate one JSON body and run the matching single-record command:
- `fabplane pcb create-board body.json --json --org "$FABPLANE_ORG"`
- `fabplane pcb create-revision BOARD_UUID body.json --json --org "$FABPLANE_ORG"`
- `fabplane pcb update-revision REVISION_UUID body.json --json --org "$FABPLANE_ORG"`
- `fabplane pcb create-order REVISION_UUID body.json --json --org "$FABPLANE_ORG"`
- `fabplane pcb update-order ORDER_UUID body.json --json --org "$FABPLANE_ORG"`

Use files or stdin for structured JSON, never concatenate untrusted source text
into shell code. Update bodies replace the complete record: include all fields,
unchanged blocker/evidence arrays and the current expectedVersion. Omit immutable
revision key; order key must remain unchanged. Re-read on 409; do not blindly retry
or silently discard a teammate's edit. A 404 may indicate missing org access.
An API response is authoritative; the CLI cannot bypass membership or bot confinement.
There is no bulk apply, delete, deploy or publication command in this PCB workflow.

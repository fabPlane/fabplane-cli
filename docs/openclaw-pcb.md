# PCB SDK / CLI / OpenClaw integration — local candidate

The existing `fabplane-cli` npm package includes all three surfaces: typed SDK,
`fabplane` CLI and stdio MCP. This is an additive proposed **0.3.1** release, not
published. Older APIs and commands remain available. An internal direct Zod 4.1.5
dependency makes the new schema snapshot independent of the application's peer
Zod choice; the existing broad peer range remains for backward compatibility.

## Contract and usage

`FabplaneClient` adds `pcb_list`, `pcb_create_board`, `pcb_create_revision`,
`pcb_update_revision`, `pcb_create_order`, `pcb_update_order`, `pcb_import_preview`.
All methods reuse the existing HTTP/auth/error transport, validate UUIDs and
request schemas locally, and delegate membership/bot confinement to the API.
There is no duplicated persistence or import execution. The copied request/type
contract in `src/pcb.ts` is a pinned source snapshot from the isolated fabplane.com
implementation, not an assertion that these routes are deployed.

```ts
import { FabplaneClient } from 'fabplane-cli';
const api = new FabplaneClient({origin:process.env.FABPLANE_API_ORIGIN,token:process.env.FABPLANE_TOKEN});
const workflow = await api.pcb_list(process.env.FABPLANE_ORG!);
const preview = await api.pcb_import_preview(process.env.FABPLANE_ORG!, {candidates:[]});
// Explicit one-record creations/updates require validated bodies.
```

CLI equivalents are `fabplane pcb list`, `create-board`, `create-revision`,
`update-revision`, `create-order`, `update-order`, `import-preview`; run
`fabplane help pcb`. Structured bodies come from JSON files or stdin (`-`).
Use `--json --org <authorized-uuid>` and an existing token from the established
credential resolver. Replacement updates require all fields and expectedVersion;
no omitted field may silently clear blockers/evidence. Conflict 409 requires review.
`fabplane mcp` now adds seven `pcb_*` tools to the existing server with explicit
schemas and mutation annotations. There is no PCB bulk apply tool. Existing
non-PCB tools remain exposed for compatibility: a PCB-only host should allowlist
only the seven `pcb_*` names rather than granting all existing management tools.

## OpenClaw template — not installed

`openclaw/fabplane-pcb/SKILL.md` uses OpenClaw's documented workspace/extra-directory
skill loader and CLI exec workflow. `openclaw/config.example.json` is a disabled
entry with a preapproved private credential-file path; it contains no credentials. Review the host's existing
skill and execution policy before enabling it. Do not overwrite existing settings,
widen exec approvals or add permissions as part of this implementation.
The host must supply preapproved stored credentials and an explicit org, and the reviewed CLI
binary must be available in the execution sandbox. Official CLI 0.3.0 already supports `fabplane bot connect`: an organization admin approves the browser code, then the requesting host receives and privately stores the bot token directly. Use a separate `FABPLANE_CREDENTIALS_FILE` for a disposable test, never overwrite ambient credentials. Do not manually extract or transfer tokens. This connection needs separate approval. Bot tokens have no automatic short TTL; explicitly delete the test bot after the bounded run.

Sources checked 2026-10-05:
[OpenClaw skills](https://docs.openclaw.ai/tools/skills) and
[skills configuration](https://docs.openclaw.ai/tools/skills-config).
This template does not claim native MCP config keys for OpenClaw. The stdio server
can be used by an already configured MCP-capable host; configuring such a host is
separate authorized work.

No running OpenClaw instance, live config, permissions or agent was touched.
Actual host behavior is **not tested**; local SDK/CLI/MCP fixtures and the real
local API router are the validation boundary. The backend migration/routes need
staging deployment and validation before a released CLI can use them remotely.

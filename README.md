# fabplane-cli

Command line, MCP server and typed TypeScript client for [fabplane.com](https://fabplane.com):
orgs, personal API tokens, carts (shopping lists / BOMs with per-item purchase destinations) and
the parts inventory. It also talks to the local fabPlane desktop app (the fabdesk daemon).

- `fabplane`: a CLI with human output by default and `--json` for scripts
- `fabplane mcp`: a stdio MCP server for Claude Code, Codex, Cursor and other agents
- `import { FabplaneClient } from "fabplane-cli"`: the same API as a library

Docs: <https://fabplane.com/docs/cli> · API reference: <https://fabplane.com/docs/api> · MIT licensed.

## Install

```sh
npm i -g fabplane-cli     # installs the `fabplane` command
npx fabplane-cli help     # or run it without installing
```

Until the first npm release, build it from source (`npm i -g github:fabPlane/fabplane-cli` does
not work: npm's global git install never has TypeScript available for the build):

```sh
git clone https://github.com/fabPlane/fabplane-cli && cd fabplane-cli
npm ci && npm pack && npm i -g ./fabplane-cli-*.tgz
```

Node.js 20 or newer is required.

## Sign in

```sh
fabplane login                       # browser device flow: prints a URL and code, waits for approval
fabplane login --token fpk_…         # store a personal API token instead
fabplane whoami
fabplane logout
```

Credentials are resolved in this order:

| What | Source |
|---|---|
| token | `--token` on `login`, then `FABPLANE_TOKEN`, then the credentials file |
| API origin | `--origin`, then `FABPLANE_API_ORIGIN`, then the origin you last logged in to, then `https://api.fabplane.com` |
| org | `--org`, then `FABPLANE_ORG`, then the default set with `fabplane orgs use`, then your personal org |

The credentials file is `$XDG_CONFIG_HOME/fabplane/credentials.json` (default
`~/.config/fabplane/credentials.json`; `%APPDATA%\fabplane\credentials.json` on Windows). It is
written atomically with mode `0600` and keeps one profile per API origin, so you can be signed in to
production and to a self-hosted or development API at the same time. `FABPLANE_CREDENTIALS_FILE`
overrides the path.

Personal API tokens (`fpk_…`) suit CI and agents: create one with `fabplane tokens create <name>`,
then set `FABPLANE_TOKEN`. `logout` does not revoke `fpk_` tokens; use `fabplane tokens revoke <id>`.

To use an API other than production, set `FABPLANE_API_ORIGIN` (for example
`http://localhost:4000` for a local fabplane API) or pass `--origin`. Password login
(`fabplane login --email … --password …`) exists only for local/development accounts and is refused
against production.

## Commands

Every command accepts `--json` (machine output), `--org <id|slug>` and `--origin <url>`.
`fabplane help <command>` prints the details.

| Command | What it does |
|---|---|
| `login [--token fpk_…] [--origin URL] [--no-browser]` | Sign in (device flow) or store a token |
| `logout` | Forget stored credentials; revokes a device session |
| `whoami` | User, API origin, token source and default org |
| `dashboard [--open]` | Print (or open) the web dashboard for the current API |
| `orgs list` | Your orgs; `*` marks the default |
| `orgs create <name> [--slug s]` | Create an org (you are owner) |
| `orgs use <id\|slug>` | Set the default org for this API origin |
| `orgs members` | Members of the org |
| `orgs invite [--email e] [--role member\|admin] [--days n]` | Create an invite link (admin) |
| `orgs invites` | Pending invites (admin) |
| `orgs role <userId> <owner\|admin\|member>` | Change a member's role |
| `orgs accept <token\|url>` | Accept an invite |
| `orgs joinable` / `orgs join <id>` | Orgs your verified email domain may join, and joining one |
| `tokens list` / `tokens create <name> [--days n]` / `tokens revoke <id>` | Personal API tokens (the secret is shown once) |
| `destinations list` | Built-in fab houses and distributors plus the org's custom ones |
| `destinations add --name N --url U [--kind k] [--base builtin:digikey]` | Add a custom destination, e.g. a regional DigiKey site |
| `carts list [--repo URL] [--project ID]` | Carts, filtered by git repo or client project id |
| `carts show <cartId>` | A cart, its items and per-destination totals |
| `carts create <name> [--repo URL …] [--project ID] [--notes T] [--fab builtin:jlcpcb]` | Create a cart |
| `carts add <cartId> --mpn M --qty N [--dest ID] [--refs R1,R2] [--sku S] [--price P --currency USD] …` | Add one item |
| `carts import <cartId> <file.json\|file.csv\|-> [--replace] [--source S]` | Add items from JSON, JSONL or a BOM CSV (500 per request); `--replace` replaces all items |
| `carts export <cartId> [--dest ID] [-o file.csv]` | CSV export, optionally for one destination |
| `carts delete <cartId>` | Delete a cart |
| `inventory list [--q text] [--category c] [--location l] [--tag t] [--limit n] [--cursor c] [--all]` | Search inventory |
| `inventory show <id>` | One item with attributes and images |
| `inventory add --name N [--mpn …] [--qty n] [--location l] [--tag t …] [--attr k=v …] [--image photo.jpg …] [--external-id id] [--server-ai]` | Add an item, optionally with photos |
| `inventory import <file.jsonl\|->  [--source S]` | Bulk upsert, 500 items per request, keyed by `externalId` |
| `inventory adjust <id> <delta> [--reason r]` | Atomic stock change, e.g. `-5` |
| `inventory delete <id>` | Delete an item and its images |
| `inventory photos queue [--all] [--limit n] [--cursor c]` | Items still waiting for a photo, with queue counts |
| `inventory photos claim [--limit N] [--lease SECONDS] [--worker NAME]` | Lease items to find photos for (default 5 for 900 s) |
| `inventory photos attach <itemId> (--url IMAGE_URL \| --file PATH) [--source-url PAGE_URL] [--source web]` | Download or read a photo, check it, upload it |
| `inventory photos skip <itemId> [--note T] [--lease-token T]` / `photos retry <itemId> [--lease-token T]` | Give up on an item (leaves the queue) or hand it back |
| `inventory photos requeue <itemId>` | Put a skipped item back in the queue (admin) |
| `mcp [--desktop]` | Run the stdio MCP server |
| `desktop status` / `desktop projects` / `desktop tools` | The local fabPlane desktop app |
| `desktop call <tool> [json-args] [--project ID] [--sync]` | Call a desktop tool |
| `api <METHOD> <path> [json\|-] [--anonymous]` | Raw request to any endpoint (escape hatch) |
| `version`, `help [command]` | |

Exit codes: `0` success, `1` API or runtime error, `2` usage error.

### Carts and destinations

Each cart item has a destination: a built-in (`builtin:jlcpcb`, `builtin:pcbway`,
`builtin:oshpark`, `builtin:digikey`, `builtin:mouser`, `builtin:lcsc`, `builtin:arrow`,
`builtin:farnell`, `builtin:aliexpress`, `builtin:amazon`, `builtin:manual`) or one of the org's
custom destinations. Items without one go to the cart's fab house (`--fab`, JLCPCB by default).

`carts import` reads CSV headers case-insensitively and understands common BOM names: `qty`,
`designator`, `mfr`, `manufacturer part number`, `LCSC Part` (as `sku`), `value`, `footprint`,
`unit price`, `destination`, `status`, `notes`. A row with no quantity column counts its designators.

```sh
fabplane carts create "Rev B" --repo https://github.com/acme/sensor-board
fabplane carts import <cartId> bom.csv
fabplane carts add <cartId> --mpn STM32G031K8T6 --qty 10 --dest builtin:lcsc
fabplane carts export <cartId> --dest builtin:lcsc -o lcsc.csv
```

## Inventory from photos: extract locally, send fields

The API stores what you send; it does not run AI on uploads. Setting `serverAiProcessing: true`
(`--server-ai` on the CLI) is answered with **HTTP 501 `server_ai_unavailable`** and nothing is
stored. Clients are expected to run a model locally (a vision model on the photo of a reel, bag
label or datasheet), extract the fields, and send them as structured data with the photo attached:

```sh
# e.g. after a local model read the label of a reel:
fabplane inventory add --name "10k 0603 resistor" --mpn RC0603FR-0710KL --manufacturer Yageo \
  --qty 5000 --unit pcs --location "Lab / drawer A3" --tag passive \
  --attr resistance=10k --attr tolerance=1% --attr package=0603 \
  --source my-scanner --external-id reel-0042 --image reel.jpg
```

For batches, write one JSON object per line and import them. Rows are upserted by
`(source, externalId)`, so re-running an import updates instead of duplicating:

```jsonl
{"name":"NE555 timer","mpn":"NE555P","manufacturer":"TI","quantity":25,"location":"Bin 4","externalId":"bin4-ne555","attributes":{"package":"DIP-8"}}
{"name":"100nF 0402 capacitor","mpn":"GRM155R71C104KA88D","quantity":10000,"externalId":"reel-0107"}
```

```sh
fabplane inventory import parts.jsonl --source my-scanner
```

Rows without an `externalId` get one derived from name, MPN, manufacturer, SKU and location.

## Photo backfill

Inventory items without an image form the org's **photo queue**. Filling it is client-side work:
a worker (a script with a local model, an agent through the MCP tools, or you on the command line)
identifies each part, finds a product photo on the web, and uploads it. The server stores what it is
given and runs no AI (`serverAiProcessing` still answers 501).

How the queue works:

- An item is **queued** while it has no images and has not been skipped. Uploading an image removes
  it; deleting its last image puts it back.
- `photos claim` **leases** items (1–25, default 5) for a while (60–3600 s, default 900) and counts an
  attempt. Leased items are hidden from other workers, so several workers can run at once. Items with
  the fewest attempts, then the oldest, come first.
- A lease ends when you **attach** a photo, **retry** (hand the item back, still queued), **skip**
  (`not_found`: no photo exists; the item leaves the queue with your note), or when it expires.
- Each claimed item comes with a **lease token**. Pass it to `photos skip` / `photos retry`
  (`--lease-token`). If your lease expired and another worker reclaimed the item, the release is refused
  with 409, which the CLI reports as "lease lost: another worker reclaimed this item; leave it alone".
- An admin can **requeue** a skipped item. `photos queue --all` lists every item without a photo,
  including leased and skipped ones.

`photos attach --url` downloads the image on your machine. It follows redirects, gives up after 20 s
(change with `--timeout <seconds>`), refuses anything over 10 MiB, and accepts only png, jpeg, webp,
gif, heic or heif. The check reads the file's leading bytes, falling back to an `image/*` content type
when the bytes are inconclusive. The upload is tagged `source: web`, with `sourceUrl` set to
`--source-url` (the product page) or, by default, the image URL. `--file` uploads a local photo
tagged `source: user`.

An example worker loop in shell. `find-photo` stands in for your local model or search step: it
prints an image URL and the page it came from, or fails when there is no photo:

```sh
while :; do
  items=$(fabplane inventory photos claim --limit 5 --worker "$(hostname)-photos" --json)
  [ "$(echo "$items" | jq '.items | length')" = 0 ] && break
  echo "$items" | jq -c '.items[]' | while read -r item; do
    id=$(echo "$item" | jq -r .id)
    lease=$(echo "$item" | jq -r .leaseToken)
    if found=$(find-photo "$item"); then          # e.g. "https://…/part.jpg https://…/product-page"
      set -- $found
      fabplane inventory photos attach "$id" --url "$1" --source-url "$2" \
        || fabplane inventory photos retry "$id" --lease-token "$lease" --note "upload failed"
    else
      fabplane inventory photos skip "$id" --lease-token "$lease" --note "no product photo found"
    fi
  done
done
```

The same loop in TypeScript:

```ts
import { FabplaneClient, fetchImage, resolveDefaultOrg } from "fabplane-cli";

const client = new FabplaneClient({ token: process.env.FABPLANE_TOKEN });
const orgId = await resolveDefaultOrg(client);
for (;;) {
  const { items } = await client.claimPhotoQueue(orgId, { limit: 5, worker: "photo-bot" });
  if (items.length === 0) break;
  for (const item of items) {
    const hit = await findPhoto(item); // your local model/search: { imageUrl, pageUrl } | null
    if (!hit) {
      await client.releasePhotoQueueItem(orgId, item.id, { outcome: "not_found", note: "no photo found", leaseToken: item.leaseToken });
      continue;
    }
    try {
      const { image } = await fetchImage(hit.imageUrl); // redirects, 10 MiB cap, type check, timeout
      await client.uploadInventoryImage(orgId, item.id, image, { source: "web", sourceUrl: hit.pageUrl });
    } catch (err) {
      // A 409 here means the lease was lost to another worker: leave the item alone.
      await client
        .releasePhotoQueueItem(orgId, item.id, { outcome: "retry", note: String(err).slice(0, 500), leaseToken: item.leaseToken })
        .catch((e) => console.warn(`release ${item.id}: ${e}`));
    }
  }
}
```

Agents get the same flow through the MCP tools: `inventory_photo_claim`, then either
`inventory_photo_attach` (`imageUrl`, or base64 `data` with `contentType`, plus `sourceUrl`) or
`inventory_photo_release`.

## MCP server

`fabplane mcp` serves these tools over stdio. They act on your default org unless the agent passes
`orgId`:

| Tool | |
|---|---|
| `org_list` | Your orgs (ids, slugs, roles) |
| `destination_list` | Purchase destinations for cart items |
| `cart_list`, `cart_get`, `cart_create` | Find, read and create carts (by repo or project id) |
| `cart_add_items`, `cart_update_item`, `cart_remove_item` | Edit cart items |
| `inventory_search`, `inventory_add`, `inventory_adjust` | Search, add and count stock |
| `inventory_photo_queue`, `inventory_photo_claim` | See and lease items that need a photo |
| `inventory_photo_attach`, `inventory_photo_release` | Attach a found photo (URL or base64), or skip/retry |

`fabplane mcp --desktop` also exposes `desktop_status`, `desktop_projects` and `desktop_call_tool`,
which reach the fabPlane desktop app running on the same machine.

Sign in first (`fabplane login`) or pass `FABPLANE_TOKEN` in the server's environment.

**Claude Code**

```sh
claude mcp add fabplane -- npx -y fabplane-cli mcp
# with a token and the desktop tools:
claude mcp add fabplane -e FABPLANE_TOKEN=fpk_… -- npx -y fabplane-cli mcp --desktop
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.fabplane]
command = "npx"
args = ["-y", "fabplane-cli", "mcp"]
# env = { FABPLANE_TOKEN = "fpk_…", FABPLANE_ORG = "my-team" }
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "fabplane": { "command": "npx", "args": ["-y", "fabplane-cli", "mcp"] }
  }
}
```

With a global install, use `"command": "fabplane", "args": ["mcp"]` instead of `npx`.

## Library

```ts
import { FabplaneClient, FabplaneApiError, resolveAuth, resolveDefaultOrg, dashboardUrlFor } from "fabplane-cli";

const client = new FabplaneClient({ token: process.env.FABPLANE_TOKEN }); // origin defaults to https://api.fabplane.com
const orgId = await resolveDefaultOrg(client); // FABPLANE_ORG, else your personal org

const { cart } = await client.createCart(orgId, { name: "Rev B", repos: ["https://github.com/acme/board"] });
await client.addCartItems(orgId, cart.id, [{ mpn: "NE555P", quantity: 4, refs: ["U1", "U2", "U3", "U4"] }]);

try {
  await client.adjustInventory(orgId, "item-id", -10, "built 10 boards");
} catch (err) {
  if (err instanceof FabplaneApiError && err.code === "conflict") console.log("not enough stock");
  else throw err;
}

console.log(dashboardUrlFor(client.origin)); // https://app.fabplane.com/dashboard
```

- Every API operation is a method named after its OpenAPI `operationId` (`listOrgs`, `createCart`,
  `replaceCartItems`, `listInventory`, `bulkUpsertInventory`, `uploadInventoryImage`, …) and resolves
  to the JSON body the API documents, e.g. `{ orgs }` or `{ items, nextCursor }`. `204` answers resolve
  to `undefined`; `exportCartCsv` resolves to CSV text.
- Also available: `startDeviceLogin`, `pollDeviceToken`, `waitForDeviceToken`, `me`, `logout`,
  `getSettings`, `putSettings`, `publicCatalog`, `config`, `sendPush`, `getPushJob`, and `raw`/`request`
  for anything else.
- Failures throw `FabplaneApiError` with `status`, `code` (the API's `error` field), `message`, `body`.
- Images: `createInventoryItem(orgId, input, [{ data, contentType, filename }])` sends multipart;
  `data` may be a `Uint8Array`, `ArrayBuffer` or `Blob`.
- Pass `fetch` to the constructor to inject your own implementation (tests, proxies).
- `fabplaneTools` is the MCP tool list as plain objects (`name`, `title`, `description`, zod
  `inputSchema` shape, `annotations`, `handler(client, args, { orgId })`) for embedding in another
  MCP server; `createFabplaneMcpServer()` builds a ready `McpServer`.
- Photo queue: `listPhotoQueue`, `claimPhotoQueue`, `releasePhotoQueueItem`, `requeuePhotoQueueItem`;
  `uploadInventoryImage(orgId, itemId, image, { source, sourceUrl })`; `fetchImage(url)` downloads and
  validates an image, `imageFromBase64(data, contentType)` validates base64 input.
- `CredentialStore` and `resolveAuth()` read and write the same credentials file as the CLI.

### The desktop app

```ts
import { FabdeskClient } from "fabplane-cli";

const desk = new FabdeskClient(); // finds daemon.json; or { baseUrl, token }, or FABDESK_URL + FABDESK_TOKEN
console.log(await desk.health(), await desk.projects());
const tools = await desk.toolManifest();
const result = await desk.callTool("board_stats", {}, { projectId: "…", sync: true });
```

`FabdeskClient` looks for `daemon.json` in `FABDESK_HOME`, then in the desktop app's data folders
(`~/Library/Application Support/{fabPlane,fabdesk,fabPlane Dev,fabdesk-dev}` on macOS,
`%APPDATA%\…` on Windows, `$XDG_CONFIG_HOME/…` on Linux), preferring a daemon whose process is alive.
It covers `health`, `projects`, `project`, `readFile`, `threads`, `createThread`, `messages`,
`sendMessage`, `liveRuns`, `toolManifest`, `callTool`, `jobs`, `job`, `waitJob`, `settings` and
`authState`.

## API spec sync

`spec/openapi.json` is a snapshot of the API's OpenAPI 3.1 document and
`src/generated/operations.ts` lists its operations. The **Sync API spec** workflow runs every Monday
at 03:00 UTC (and on demand): it fetches `/v1/public/openapi.json`, regenerates both files and opens
or updates a pull request when something changed, listing operations that have no `FabplaneClient`
method yet. A test fails while any `operationId` lacks a method. If the API does not serve the
document yet (404), the job ends without changes.

```sh
npm run sync-spec                 # fetch from FABPLANE_API_ORIGIN (default https://api.fabplane.com)
npm run sync-spec -- --offline    # regenerate from the committed snapshot only
```

`spec/fabdesk-tools.json` is a snapshot of the desktop app's tool manifest (names, toolsets,
descriptions and JSON-schema inputs, as served by `GET /tools/manifest`). The fabdesk repository
refreshes it with a pull request here when its tools change.

Both weekly sync jobs use a GitHub App installed on **only** `fabPlane/fabplane-cli`, with
**Contents** and **Pull requests** read/write permissions. Set `FABPLANE_CLI_SYNC_APP_ID` as an
Actions variable and `FABPLANE_CLI_SYNC_APP_PRIVATE_KEY` as an Actions secret in **both** this
repository and `TensorFleet/fabdesk`. Each run creates a short-lived installation token scoped to
`fabplane-cli`; the private key is never committed. The job fails early if either setting is missing.
The App does not need installation on fabdesk: that workflow requests a token for the fabPlane
installation to open a pull request here.

## Contributing

```sh
npm ci
npm run build      # tsc → dist/
npm test           # compiles src + test and runs node --test
bun test           # the same tests straight from TypeScript
```

Tests run against a small in-memory fake of the API (`test/fake-api.ts`) and of the desktop daemon
(`test/fake-daemon.ts`); no network access is needed. Keep runtime dependencies to
`@modelcontextprotocol/sdk` and `zod` (imported as `zod/v4`), and keep `src/` free of Bun-only APIs:
the package must run under plain Node. Bun workspaces that vendor this repo get `src/index.ts`
through the `bun` export condition.

## Publishing

Releases go to npm from GitHub Actions (`.github/workflows/publish.yml`), which needs an npm token
that has not been added yet:

1. On npmjs.com, create an **automation** (or granular publish) token that can publish the
   `fabplane-cli` package.
2. Add it as the `NPM_TOKEN` repository secret: Settings → Secrets and variables → Actions.
3. Bump `version` in `package.json` and `src/version.ts`, then publish a GitHub release or push a
   `v*` tag (e.g. `v0.1.1`). The workflow builds, tests and runs `npm publish --provenance`.

Without the secret the workflow fails on its first step with an error asking for it, and publishes
nothing. Until the first release, install from source as described under Install.

## License

MIT

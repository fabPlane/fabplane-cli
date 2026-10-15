---
name: onboarding
description: Get started with fabPlane — sign in, open PCB projects on the desktop, and review shopping lists (carts / BOMs). Use when installing the fabPlane plugin, when the user says "open my boards", asks for a shopping list for this project, or wants to design, review or order a board.
---

# fabPlane onboarding

fabPlane is a PCB workspace: the cloud API holds orgs, shopping lists (carts / BOMs) and the parts inventory; the local desktop app holds KiCad projects and the CAD tools (build, place, route, DRC, fab exports). This plugin starts the `fabplane` MCP server (`npx -y fabplane-cli mcp --desktop`).

Do not invent API tokens or ask the user to paste secrets into chat. Never print a token.

## Sign in

The MCP tools talk to fabplane.com as whoever is signed in on this machine.

1. If tools fail with 401 or "Not logged in", ask the user to sign in in their own terminal:

   ```sh
   fabplane login
   fabplane whoami
   ```

   `fabplane login` opens a browser device-flow URL and prints a short code. The user approves it on fabplane.com. For CI or a headless review they can instead create a personal API token (`fabplane tokens create <name>`) and set `FABPLANE_TOKEN` in the MCP server env — do not echo that value.

2. Call `org_list`. Tools default to the user's default org (personal org, or `FABPLANE_ORG` / `fabplane orgs use`). Pass `orgId` only when they name a different team.

3. Optional local desktop: `desktop_status`. If the fabPlane desktop app is running, `desktop_projects` and `desktop_call_tool` reach its PCB tools. If it is not running, keep using the cloud cart and inventory tools and say the desktop tools need the app.

## "Open my boards"

Map this to the local desktop, not a web crawl.

1. `desktop_status` — is the app running and signed in?
2. `desktop_projects` — list id + name.
3. If they named a board, pick that project. Otherwise show the list and open the most recently used one.
4. `desktop_call_tool` without `name` lists every desktop tool (build, place, route, DRC, renders, gerbers, BOM, …).
5. To focus a project in the app: `desktop_call_tool` with `name` `app_select_project` (and `app_open_tab` when they want a board / schematic / 3D view). Use the `projectId` from the list.

If the desktop app is not running, say so and offer the shopping-list / inventory tools instead.

## "Show the shopping list for this project"

A cart is a shopping list / BOM. It can be tagged with a git `repo` and/or a desktop `projectId`.

1. `cart_list` filtered by `projectId` (from `desktop_projects`) or `repo` when you know the git URL. Prefer an existing cart over creating one.
2. `cart_get` on that cart. Summarize items by destination (`builtin:jlcpcb`, `builtin:lcsc`, `builtin:digikey`, …) and status (`needed` / `ordered` / `received`).
3. Before adding a part, `inventory_search` — if enough is on the shelf, say so instead of buying it.
4. `destination_list` when you need a destination id. `cart_add_items` / `cart_update_item` to edit. Never place an order; the cart is for a person to review.

If there is no cart, `cart_create` with the project's `repos` and `projectId`, then add items.

## Cloud tools (always available once signed in)

| Tool | Use |
|---|---|
| `org_list` | Workspaces the user belongs to |
| `destination_list` | Fab houses and distributors |
| `cart_list`, `cart_get`, `cart_create` | Find / read / create shopping lists |
| `cart_add_items`, `cart_update_item`, `cart_remove_item` | Edit line items |
| `inventory_search`, `inventory_add`, `inventory_adjust` | Parts on the shelf |
| `inventory_photo_queue`, `inventory_photo_claim`, `inventory_photo_attach`, `inventory_photo_release` | Fill missing part photos |

Inventory fields are extracted locally (label, photo, datasheet) and sent structured. Do not ask the server to run AI on uploads.

## Desktop tools (`--desktop`)

`desktop_call_tool` is the escape hatch onto the local app. Typical names: `project_status`, `circuit_build`, `circuit_place`, `circuit_query`, `route_run`, `verify_drc`, `verify_erc`, `render_board`, `export_gerbers`, `export_bom`, `export_zip`. Omit `name` to refresh the manifest. Pass `projectId` for project-scoped tools. Set `sync` true on long-running ones (route, DRC) when the user wants to wait.

## First-session script

1. Sign-in check (`org_list`).
2. Open boards (`desktop_projects` → select / show).
3. Show the shopping list for the current project (`cart_list` → `cart_get`).
4. Offer a next step: DRC (`verify_drc`), fab exports (`export_zip`), or adding a missing part to the cart.

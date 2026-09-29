---
name: fabplane-inventory
description: Keep the team's parts inventory and shopping lists on fabplane.com with the `fabplane` CLI, and backfill missing part photos. Use whenever parts, boards, modules, cables or tools are received, counted, used up, moved or asked about ("what do we have", "log this delivery", "we used 4 of X"), when a build needs a shopping list, for photos of parts to catalogue, and for the periodic photo backfill job.
user-invocable: true
argument-hint: "[what arrived / what to look up / photo backfill]"
---

# fabplane inventory, carts and photo backfill

The team inventory and shopping lists live in a fabplane.com org. You reach them with the
`fabplane` CLI, which is signed in as this agent's **bot** (`fabplane bot connect`), so every command
acts on the bot's org by default. Check with `fabplane whoami`; it should say `kind: bot`.

Always pass `--json` when you need to read the result, and report failures with the CLI's error text.

## Inventory upkeep

```bash
fabplane whoami                                   # origin, bot name, org
fabplane inventory list --q "<text>" --json       # search BEFORE adding (avoid duplicates)
fabplane inventory show <itemId> --json
fabplane inventory add --name "<name>" [--mpn M] [--manufacturer M] [--sku S] \
  [--category C] [--description D] [--qty N] [--unit pcs] [--location L] \
  [--tag T ...] [--attr key=value ...] --source openclaw \
  --external-id openclaw:<stable-slug> [--image /path/photo.jpg ...] --json
fabplane inventory adjust <itemId> <+N|-N> --reason "<why>" --json   # received / used (atomic)
fabplane inventory import items.jsonl --source openclaw               # bulk upsert, one JSON object per line
```

Rules:

- **Search first.** `inventory list --q` by MPN, then by name. If the item exists, `adjust` its quantity
  instead of adding a second row.
- **Stable external ids.** Always pass `--source openclaw` and `--external-id openclaw:<slug>`, where the
  slug is derived from what the part *is* (e.g. `openclaw:usb-c-breakout-16p`), not from the date or the
  delivery. Re-adding the same id updates the item instead of duplicating it, so retries are safe.
- **You do the extraction.** Read labels, photos, invoices and datasheets yourself and send structured
  fields: name, MPN, manufacturer, quantity, category, location. Anything without its own flag goes into
  `--attr key=value` (package, pitch, pin count, voltage, colour…).
- **Never use `--server-ai`.** Server-side AI processing is not available; it returns HTTP 501 and stores
  nothing.
- **Photos.** When the user sent a photo of the part, save it to a temporary file and pass `--image <file>`
  (png, jpeg, webp, gif, heic; at most 10 MiB each).
- Quantities are integers. `adjust` refuses to go below zero; recount instead of forcing it.
- After a change, tell the user the item name, the new quantity and the item id.

## Shopping lists (carts)

A cart is a shopping list / BOM, optionally tagged with a git repo or a project id. Each item has a
purchase destination (`builtin:jlcpcb`, `builtin:lcsc`, `builtin:digikey`, `builtin:mouser`,
`builtin:manual`, … or a custom one from `fabplane destinations list`).

```bash
fabplane carts list [--repo <git-url>] [--project <id>] --json
fabplane carts show <cartId> --json
fabplane carts create "<name>" [--repo <git-url>] [--notes "<text>"] --json
fabplane carts add <cartId> --mpn <MPN> --qty <N> [--dest builtin:lcsc] [--refs R1,R2] [--manufacturer M] --json
fabplane carts import <cartId> bom.csv            # a KiCad/JLC-style BOM CSV, or JSON
fabplane carts export <cartId> [--dest builtin:lcsc] -o order.csv
```

- Look for an existing cart for the same repo or project before creating one.
- Before adding a part, check the inventory: if enough is on the shelf, say so instead of buying it.
- Never place orders; a cart is a list for a person to review and buy.

## Photo backfill (periodic job)

fabplane keeps a queue of inventory items that have no photo. You are the "local AI" that fills it;
nothing is processed server-side.

1. `fabplane inventory photos queue --json` shows the counts.
   `fabplane inventory photos claim --limit 5 --worker openclaw --json` leases up to 5 items for 15 minutes.
   Only work on items you claimed.
2. For each claimed item, find a clear product photo of **that exact part**:
   - Search by MPN + manufacturer first; fall back to the name and attributes.
   - Prefer the manufacturer's product page, then a major distributor's product page. Marketplace
     listings are acceptable only when nothing better exists.
   - Use the main product image: not a logo, banner, schematic or datasheet page.
   - **Look at the image before attaching it** and check it matches the item: form factor,
     connector/pin count, colour when the name says one.
   - For generic parts (e.g. a jumper-wire bundle), a representative photo of the same kind of part is
     fine; say so in the note.
3. If it matches:
   `fabplane inventory photos attach <itemId> --url <direct image URL> --source-url <product page URL>`.
   The CLI downloads it, checks it is an image of at most 10 MiB, and uploads it; the item leaves the queue.
4. If the part cannot be identified or there is no trustworthy photo:
   `fabplane inventory photos skip <itemId> --note "<why>"` (e.g. unlabeled bag, salvaged assembly,
   the team's own board). Someone can photograph it later with `photos attach <itemId> --file <photo>`.
5. If the search failed for a transient reason:
   `fabplane inventory photos retry <itemId> --note "<what failed>"`.
6. Never attach a different part's photo. A skip is better than a wrong image.
7. Reply with one line per item: `name → attached (source host) | skipped (reason) | retry (reason)`.

## Optional: mirror to a notes page

If the workspace keeps a human-readable inventory page (a wiki or notes file), update it after each
change with the item name, MPN, quantity, location and the fabplane item id (`.item.id` from `--json`).
Treat fabplane as the source of truth; if one write fails, still do the other and say which failed.

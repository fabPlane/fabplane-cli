---
name: fabplane-inventory
description: fabplane inventory, carts and photo backfill
version: 0.3.0
author: fabPlane
license: MIT
metadata:
  hermes:
    tags: [inventory, electronics, pcb, fabplane]
    category: productivity
    requires_toolsets: [terminal]
---

# fabplane inventory, carts and photo backfill

Keep a team's parts inventory and shopping lists on fabplane.com through the `fabplane` CLI, and
fill in missing part photos. The CLI is signed in as this agent's **bot** (`fabplane bot connect`),
so every command acts on the bot's org by default.

## When to Use

- Parts, boards, modules, cables or tools are received, counted, used up, moved, or asked about
  ("what do we have", "log this delivery", "we used 4 of X").
- A photo or label of a part should be catalogued.
- A build needs a shopping list / BOM.
- The scheduled photo backfill job runs.

## Quick Reference

```bash
fabplane whoami                                   # should say kind: bot, and the org
fabplane inventory list --q "<text>" --json       # search BEFORE adding
fabplane inventory show <itemId> --json
fabplane inventory add --name "<name>" [--mpn M] [--manufacturer M] [--category C] [--qty N] \
  [--location L] [--tag T ...] [--attr key=value ...] --source hermes \
  --external-id hermes:<stable-slug> [--image /path/photo.jpg ...] --json
fabplane inventory adjust <itemId> <+N|-N> --reason "<why>" --json
fabplane inventory import items.jsonl --source hermes
fabplane carts list [--repo <git-url>] --json
fabplane carts create "<name>" [--repo <git-url>] --json
fabplane carts add <cartId> --mpn <MPN> --qty <N> [--dest builtin:lcsc] [--refs R1,R2] --json
fabplane carts show <cartId> --json
fabplane inventory photos queue --json
fabplane inventory photos claim --limit 5 --worker hermes --json
fabplane inventory photos attach <itemId> --url <image URL> --source-url <product page URL>
fabplane inventory photos skip <itemId> --note "<why>"
fabplane inventory photos retry <itemId> --note "<what failed>"
```

## Procedure

### Inventory upkeep

1. Search first: `fabplane inventory list --q "<mpn or name>" --json`. If the item exists, change its
   quantity with `fabplane inventory adjust` instead of adding a duplicate.
2. Otherwise extract the fields yourself from the label, photo, invoice or datasheet and add the item
   with `fabplane inventory add`. Put fields without their own flag into `--attr key=value`.
3. Always pass `--source hermes` and `--external-id hermes:<slug>`, with a slug derived from what the
   part is (e.g. `hermes:usb-c-breakout-16p`). Re-adding the same id updates the item.
4. If the user sent a photo, save it to a temporary file and pass `--image <file>`.
5. Tell the user the item name, new quantity and item id.

### Shopping lists (carts)

1. Look for an existing cart for the repo or project: `fabplane carts list --repo <git-url> --json`.
2. Create one if needed, then add items with `fabplane carts add` (or `fabplane carts import <cartId> bom.csv`).
3. Check the inventory before adding a part; if enough is on hand, say so instead.
4. Never place orders; a cart is a list for a person to review.

### Photo backfill

1. Claim work: `fabplane inventory photos claim --limit 5 --worker hermes --json`. Only touch claimed items.
2. For each item, search by MPN + manufacturer (then name and attributes) for the product image, preferring
   the manufacturer's page, then a major distributor's page.
3. Look at the image and check it matches the item (form factor, pin/connector count, colour).
4. Matches: `fabplane inventory photos attach <itemId> --url <image URL> --source-url <product page URL>`.
5. Not identifiable or no trustworthy photo: `fabplane inventory photos skip <itemId> --note "<why>"`.
6. Transient failure: `fabplane inventory photos retry <itemId> --note "<what failed>"`.
7. Report one line per item: `name → attached (source host) | skipped (reason) | retry (reason)`.

## Pitfalls

- Never use `--server-ai`: server-side AI processing is not available (HTTP 501) and nothing is stored.
- Never attach a different part's photo; skipping is better than a wrong image.
- `adjust` refuses to go below zero; recount rather than forcing it.
- A bot cannot manage tokens, invites or other orgs (HTTP 403). Ask a person with an admin account.

## Verification

- `fabplane whoami` shows `kind: bot` and the expected org.
- After an add or adjust, `fabplane inventory show <itemId> --json` shows the new state.
- After a backfill pass, `fabplane inventory photos queue --json` counts went down.

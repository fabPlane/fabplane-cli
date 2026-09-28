/**
 * MCP-ready tool definitions over `FabplaneClient` (and `FabdeskClient` for the desktop tools).
 * Handlers never throw for API failures: they answer `{ isError: true, text }` so an agent can
 * read the reason and recover.
 */
import { z } from "zod/v4";
import type { FabplaneClient } from "./client.js";
import { FabplaneApiError } from "./errors.js";
import { FabdeskError, type FabdeskClient } from "./fabdesk.js";
import type { CartItemInput, InventoryItemInput } from "./types.js";

export type ToolResult = { text?: string; json?: unknown; isError?: boolean };
export type ToolContext = { orgId?: string | undefined };
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export interface ToolDef<C, S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Written for an LLM: when to call it, what it needs, what it returns. */
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  handler(client: C, args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}

export type FabplaneTool = ToolDef<FabplaneClient>;
export type DesktopTool = ToolDef<FabdeskClient>;

function defineTool<C, S extends z.ZodRawShape>(def: ToolDef<C, S>): ToolDef<C> {
  return def as unknown as ToolDef<C>;
}

const orgIdArg = z
  .string()
  .optional()
  .describe("Org id (UUID). Omit to use the default org (FABPLANE_ORG, `fabplane orgs use`, or your personal org).");

function errorResult(err: unknown): ToolResult {
  if (err instanceof FabplaneApiError) {
    return { isError: true, text: `fabplane API error ${err.status} ${err.code}: ${err.message}`, json: { status: err.status, error: err.code, message: err.message } };
  }
  if (err instanceof FabdeskError) return { isError: true, text: err.message, json: { status: err.status, error: err.message } };
  return { isError: true, text: err instanceof Error ? err.message : String(err) };
}

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return errorResult(err);
  }
}

function orgOf(args: { orgId?: string | undefined }, ctx: ToolContext): string {
  const org = args.orgId ?? ctx.orgId;
  if (!org) throw new Error("No org selected: pass orgId (see org_list) or set a default org with `fabplane orgs use <slug>`.");
  return org;
}

/** Drops undefined values so `exactOptionalPropertyTypes` bodies stay clean. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
function compact<T extends Record<string, unknown>>(obj: T): Defined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Defined<T>;
}

const destinationIdArg = z
  .string()
  .describe("Where to buy it: `builtin:<key>` (builtin:jlcpcb, builtin:pcbway, builtin:oshpark, builtin:digikey, builtin:mouser, builtin:lcsc, builtin:arrow, builtin:farnell, builtin:aliexpress, builtin:amazon, builtin:manual) or a custom destination id from destination_list.");

const cartItemFields = {
  kind: z.enum(["pcb", "part", "other"]).optional().describe('"part" (default), "pcb" for a bare/assembled board order, or "other".'),
  mpn: z.string().optional().describe("Manufacturer part number."),
  manufacturer: z.string().optional(),
  description: z.string().optional(),
  value: z.string().optional().describe('Component value, e.g. "10k" or "100nF".'),
  footprint: z.string().optional(),
  refs: z.array(z.string()).max(500).optional().describe('Reference designators, e.g. ["R1","R2"].'),
  destinationId: destinationIdArg.optional().describe("Purchase destination; defaults to the cart's fab house (JLCPCB unless changed)."),
  sku: z.string().optional().describe("Distributor part number or LCSC C-number."),
  url: z.string().optional().describe("Product page URL."),
  unitPrice: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional().describe("ISO 4217 code, e.g. USD."),
  status: z.enum(["needed", "ordered", "received"]).optional(),
  notes: z.string().optional(),
  inventoryItemId: z.string().nullable().optional().describe("Link to an inventory item this line is fulfilled from."),
};

const cartItemInput = z.object({
  ...cartItemFields,
  quantity: z.number().int().min(0).describe("How many to buy (integer ≥ 0)."),
});

const attributesArg = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional()
  .describe('Semi-structured fields (≤100 keys), e.g. {"resistance":"10k","tolerance":"1%","package":"0603"}.');

function summarizeCart(cart: { id: string; name: string; itemCount?: number; items?: unknown[] }): string {
  const count = cart.items ? cart.items.length : cart.itemCount ?? 0;
  return `Cart "${cart.name}" (${cart.id}), ${count} item${count === 1 ? "" : "s"}`;
}

export const fabplaneTools: FabplaneTool[] = [
  defineTool<FabplaneClient, Record<string, never>>({
    name: "org_list",
    title: "List my fabplane orgs",
    description:
      "List the fabplane.com organizations (workspaces) the signed-in user belongs to, including their personal org. Returns id, slug, name, role and whether it is personal. Call this first when you need an orgId for the other fabplane tools or when the user mentions a team by name.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (client) =>
      guarded(async () => {
        const { orgs } = await client.listOrgs();
        const lines = orgs.map((o) => `- ${o.name} (${o.slug}) id=${o.id} role=${o.role}${o.personal ? " [personal]" : ""}`);
        return { text: lines.length ? `Orgs:\n${lines.join("\n")}` : "No orgs.", json: { orgs } };
      }),
  }),
  defineTool({
    name: "destination_list",
    title: "List purchase destinations",
    description:
      "List where cart items can be bought for an org: built-in fab houses (JLCPCB, PCBWay, OSH Park), distributors (DigiKey, Mouser, LCSC, Arrow, Farnell, AliExpress, Amazon), `builtin:manual`, and the org's custom destinations (e.g. a regional DigiKey site). Use the returned ids as destinationId on cart items.",
    inputSchema: { orgId: orgIdArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { destinations } = await client.listDestinations(orgOf(args, ctx));
        const lines = destinations.map((d) => `- ${d.id}: ${d.name} (${d.kind})${d.url ? ` ${d.url}` : ""}`);
        return { text: `Destinations:\n${lines.join("\n")}`, json: { destinations } };
      }),
  }),
  defineTool({
    name: "cart_list",
    title: "List carts (shopping lists / BOMs)",
    description:
      "List an org's carts: shopping lists or bills of materials for PCB projects. Filter by `repo` (a git URL; matching is normalized, so https and git@ forms of the same repo match) or `projectId` (e.g. a fabdesk project id) to find the cart for the project you are working on before creating a new one.",
    inputSchema: {
      orgId: orgIdArg,
      repo: z.string().optional().describe("Git repository URL the cart is tagged with."),
      projectId: z.string().optional().describe("Opaque client project id the cart is tagged with."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { carts } = await client.listCarts(orgOf(args, ctx), compact({ repo: args.repo, projectId: args.projectId }));
        const lines = carts.map((c) => `- ${summarizeCart(c)}${c.repos.length ? ` repos=${c.repos.join(",")}` : ""}${c.projectId ? ` project=${c.projectId}` : ""}`);
        return { text: lines.length ? `Carts:\n${lines.join("\n")}` : "No carts match.", json: { carts } };
      }),
  }),
  defineTool({
    name: "cart_get",
    title: "Get a cart with its items",
    description:
      "Fetch one cart with every item (mpn, quantity, refs, destination, status, price) and per-destination totals. Use it to review a BOM, check what is still `needed`, or find an itemId before cart_update_item / cart_remove_item.",
    inputSchema: { orgId: orgIdArg, cartId: z.string().describe("Cart id from cart_list.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { cart } = await client.getCart(orgOf(args, ctx), args.cartId);
        const lines = cart.items.map(
          (i) => `- ${i.id}: ${i.quantity}× ${i.mpn ?? i.description ?? i.kind}${i.refs?.length ? ` [${i.refs.join(",")}]` : ""} → ${i.destinationId} (${i.status})`,
        );
        return { text: `${summarizeCart(cart)}\n${lines.join("\n")}`, json: { cart } };
      }),
  }),
  defineTool({
    name: "cart_create",
    title: "Create a cart",
    description:
      "Create a new cart (shopping list / BOM) in an org. Tag it with the project's git `repos` and/or `projectId` so it can be found again with cart_list. `fabDestinationId` is the default destination for items that do not name one (JLCPCB when omitted: the fab assembles and sources everything unless an item is moved to a distributor or builtin:manual).",
    inputSchema: {
      orgId: orgIdArg,
      name: z.string().min(1).max(120),
      repos: z.array(z.string()).max(20).optional().describe("Git repository URLs this cart belongs to."),
      projectId: z.string().max(200).optional().describe("Opaque client project id, e.g. a fabdesk project id."),
      notes: z.string().max(4000).optional(),
      fabDestinationId: destinationIdArg.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { orgId, ...rest } = args;
        const { cart } = await client.createCart(orgOf({ orgId }, ctx), compact(rest));
        return { text: `Created ${summarizeCart(cart)}`, json: { cart } };
      }),
  }),
  defineTool({
    name: "cart_add_items",
    title: "Add items to a cart",
    description:
      "Append 1–500 line items to a cart. Each item needs a `quantity`; give an `mpn` (and manufacturer) for parts, `refs` for the designators it covers, and optionally `destinationId`, `sku`, `url`, `unitPrice`/`currency`. Items without a destination go to the cart's fab house. Returns the created items with their ids.",
    inputSchema: {
      orgId: orgIdArg,
      cartId: z.string(),
      items: z.array(cartItemInput).min(1).max(500),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const items = args.items.map((i) => compact(i) as CartItemInput);
        const res = await client.addCartItems(orgOf(args, ctx), args.cartId, items);
        return { text: `Added ${res.items.length} item(s) to cart ${args.cartId}`, json: res };
      }),
  }),
  defineTool({
    name: "cart_update_item",
    title: "Update a cart item",
    description:
      "Change one cart item: quantity, status (needed → ordered → received), destinationId (move it to a distributor or builtin:manual), sku, url, price, notes, etc. Only the fields you pass change.",
    inputSchema: {
      orgId: orgIdArg,
      cartId: z.string(),
      itemId: z.string().describe("Item id from cart_get."),
      ...cartItemFields,
      quantity: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { orgId, cartId, itemId, ...patch } = args;
        const res = await client.updateCartItem(orgOf({ orgId }, ctx), cartId, itemId, compact(patch) as Partial<CartItemInput>);
        return { text: `Updated item ${itemId}`, json: res };
      }),
  }),
  defineTool({
    name: "cart_remove_item",
    title: "Remove a cart item",
    description: "Delete one item from a cart. This cannot be undone; confirm with the user when the item was not just added by you.",
    inputSchema: { orgId: orgIdArg, cartId: z.string(), itemId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        await client.deleteCartItem(orgOf(args, ctx), args.cartId, args.itemId);
        return { text: `Removed item ${args.itemId} from cart ${args.cartId}`, json: { ok: true } };
      }),
  }),
  defineTool({
    name: "inventory_search",
    title: "Search parts inventory",
    description:
      "Search an org's parts inventory (what is physically on the shelf). `q` matches name, mpn, manufacturer, description and sku case-insensitively; filter further by category, location or tag. Use it before adding parts to a cart to see what is already in stock. Paged: pass `cursor` from a previous result's nextCursor.",
    inputSchema: {
      orgId: orgIdArg,
      q: z.string().optional(),
      category: z.string().optional(),
      location: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
      cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { orgId, ...query } = args;
        const res = await client.listInventory(orgOf({ orgId }, ctx), compact(query));
        const lines = res.items.map((i) => `- ${i.id}: ${i.name}${i.mpn ? ` (${i.mpn})` : ""} qty=${i.quantity} ${i.unit}${i.location ? ` @ ${i.location}` : ""}`);
        return {
          text: `${lines.length ? lines.join("\n") : "No inventory items match."}${res.nextCursor ? `\nMore: cursor=${res.nextCursor}` : ""}`,
          json: res,
        };
      }),
  }),
  defineTool({
    name: "inventory_add",
    title: "Add an inventory item",
    description:
      "Record a part in the org's inventory. Extract the fields yourself (from a photo, label, datasheet or the user's words) and send them structured: name is required; add mpn, manufacturer, category, quantity, location, tags and free-form `attributes`. Set `source` + `externalId` to make repeated calls upsert instead of duplicating. The server does not run AI extraction (serverAiProcessing is unavailable), so do the extraction locally.",
    inputSchema: {
      orgId: orgIdArg,
      name: z.string().min(1).max(200),
      mpn: z.string().optional(),
      manufacturer: z.string().optional(),
      sku: z.string().optional(),
      category: z.string().optional(),
      description: z.string().optional(),
      quantity: z.number().int().min(0).optional().describe("Default 0."),
      unit: z.string().optional().describe('Default "pcs".'),
      location: z.string().optional().describe('e.g. "Lab / drawer A3".'),
      tags: z.array(z.string()).max(50).optional(),
      attributes: attributesArg,
      source: z.string().optional().describe('Who is adding it, e.g. "claude", "fabdesk".'),
      externalId: z.string().optional().describe("Idempotency key, unique per (org, source)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { orgId, ...input } = args;
        const { item } = await client.createInventoryItem(orgOf({ orgId }, ctx), compact(input) as InventoryItemInput);
        return { text: `Saved inventory item ${item.name} (${item.id}), qty ${item.quantity} ${item.unit}`, json: { item } };
      }),
  }),
  defineTool({
    name: "inventory_adjust",
    title: "Adjust inventory quantity",
    description:
      "Atomically add to or take from an inventory item's quantity: positive `delta` when parts arrive, negative when they are used. Fails with a conflict if the result would go below zero. Add a short `reason` (e.g. \"built 5 boards\").",
    inputSchema: {
      orgId: orgIdArg,
      itemId: z.string(),
      delta: z.number().int().refine((d) => d !== 0, "delta must not be 0"),
      reason: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: (client, args, ctx) =>
      guarded(async () => {
        const { item } = await client.adjustInventory(orgOf(args, ctx), args.itemId, args.delta, args.reason);
        return { text: `${item.name}: quantity now ${item.quantity} ${item.unit}`, json: { item } };
      }),
  }),
];

export const FABPLANE_TOOL_NAMES = fabplaneTools.map((t) => t.name);

/** Tools over the local fabdesk daemon, exposed by `fabplane mcp --desktop`. */
export const desktopTools: DesktopTool[] = [
  defineTool<FabdeskClient, Record<string, never>>({
    name: "desktop_status",
    title: "fabdesk desktop status",
    description:
      "Check whether the fabPlane desktop app (fabdesk daemon) is running on this machine, its version, whether it is signed in to fabplane.com, and which agent runs are live.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (desk) =>
      guarded(async () => {
        const health = await desk.health();
        const auth = await desk.authState().catch(() => null);
        const live = await desk.liveRuns().catch(() => []);
        const who = auth?.principal?.handle ?? auth?.principal?.subject;
        return {
          text: `fabdesk ${health.version ?? "?"} running (auth ${auth ? `${auth.mode}/${auth.status}${who ? ` as ${who}` : ""}` : "unknown"}), ${live.length} live run(s)`,
          json: { health, auth, liveRuns: live },
        };
      }),
  }),
  defineTool<FabdeskClient, Record<string, never>>({
    name: "desktop_projects",
    title: "List fabdesk projects",
    description: "List the PCB projects in the local fabdesk desktop app (id and name). Use a project id with desktop_call_tool for project-scoped tools.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (desk) =>
      guarded(async () => {
        const projects = await desk.projects();
        return { text: projects.map((p) => `- ${p.id}: ${p.name}`).join("\n") || "No projects.", json: { projects } };
      }),
  }),
  defineTool({
    name: "desktop_call_tool",
    title: "Call a fabdesk tool",
    description:
      "Call any tool of the local fabdesk desktop app by name (schematic/PCB queries, routing, DRC, renders, exports, BOM…). Pass `name` and its `args`; set `projectId` for project-scoped tools. Long-running tools return a jobId unless `sync` is true. Omit `name` to get the list of available tools with their input schemas.",
    inputSchema: {
      name: z.string().optional().describe("fabdesk tool name; omit to list tools."),
      args: z.record(z.string(), z.unknown()).optional(),
      projectId: z.string().optional(),
      sync: z.boolean().optional().describe("Wait for long-running tools instead of returning a jobId."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: (desk, args) =>
      guarded(async () => {
        if (!args.name) {
          const tools = await desk.toolManifest();
          return { text: tools.map((t) => `- ${t.name} (${t.toolset}): ${t.title}`).join("\n"), json: { tools } };
        }
        const res = await desk.callTool(args.name, args.args ?? {}, compact({ projectId: args.projectId, sync: args.sync }));
        if (res.jobId) return { text: `Queued as job ${res.jobId}`, json: res };
        return { text: res.text ?? "ok", json: res.json ?? res, ...(res.ok === false ? { isError: true } : {}) };
      }),
  }),
];

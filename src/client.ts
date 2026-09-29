/**
 * Typed client for the fabplane.com API. Every contract operationId is a method of the same
 * name and returns the JSON body the contract documents (envelope included, e.g. `{ orgs }`).
 * Routes that answer 204 resolve to `undefined`. Failures throw `FabplaneApiError`.
 */
import { FabplaneApiError } from "./errors.js";
import { DEFAULT_API_ORIGIN, normalizeOrigin } from "./origin.js";
import type {
  ApiToken,
  AuthMeResponse,
  Cart,
  CartItem,
  CartItemInput,
  CartSummary,
  CloudSettings,
  CreateCartInput,
  CreateDestinationInput,
  CreateInviteInput,
  CreateOrgInput,
  CreateTokenInput,
  Destination,
  DeviceCodeResponse,
  DevicePollOutcome,
  DeviceTokenResponse,
  ImageUpload,
  InventoryImage,
  InventoryItem,
  InventoryItemInput,
  Invite,
  InvitePreview,
  ListCartsQuery,
  ListInventoryQuery,
  ListPhotoQueueQuery,
  ClaimPhotoQueueInput,
  PhotoQueueCounts,
  PhotoQueueItem,
  ReleasePhotoQueueInput,
  ClaimedPhotoQueueItem,
  UploadImageOptions,
  Member,
  MeResponse,
  Bot,
  BotConnectPollOutcome,
  BotConnectRequest,
  BotConnectStart,
  BotConnectToken,
  CreateBotInput,
  StartBotConnectInput,
  MeUser,
  Org,
  OrgSummary,
  PublicCatalog,
  PublicConfig,
  PushJob,
  PushMessage,
  PushResponse,
  Role,
  UpdateCartInput,
  UpdateOrgInput,
} from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FabplaneClientOptions {
  /** API origin; default `https://api.fabplane.com`. */
  origin?: string;
  /** Bearer token: `fpk_…` personal API token or `fpd_…` device token. */
  token?: string;
  fetch?: FetchLike;
  /** OAuth client id sent in the device flow; default `fabplane-cli`. */
  clientId?: string;
  /** Extra headers sent with every request (e.g. a `user-agent`). */
  headers?: Record<string, string>;
}

export const DEFAULT_CLIENT_ID = "fabplane-cli";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type Query = Record<string, string | number | boolean | undefined | null>;

type RequestOptions = {
  query?: Query;
  json?: unknown;
  body?: NonNullable<RequestInit["body"]>;
  headers?: Record<string, string>;
  /** Do not send the bearer token. */
  anonymous?: boolean;
  redirect?: NonNullable<RequestInit["redirect"]>;
};

const enc = encodeURIComponent;

function toBlob(image: ImageUpload): Blob {
  if (image.data instanceof Blob) {
    return image.data.type === image.contentType ? image.data : new Blob([image.data], { type: image.contentType });
  }
  const bytes = image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: image.contentType });
}

function extensionFor(contentType: string): string {
  const sub = contentType.split("/")[1]?.split(";")[0]?.trim() ?? "bin";
  return sub === "jpeg" ? "jpg" : sub;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class FabplaneClient {
  readonly origin: string;
  readonly clientId: string;
  token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: FabplaneClientOptions = {}) {
    this.origin = normalizeOrigin(options.origin ?? DEFAULT_API_ORIGIN);
    this.token = options.token;
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.extraHeaders = options.headers ?? {};
  }

  /** The fetch this client uses (also used to download images for photo backfill). */
  get fetcher(): FetchLike {
    return this.fetchImpl;
  }

  /** A copy of this client using another bearer token. */
  withToken(token: string | undefined): FabplaneClient {
    return new FabplaneClient({
      origin: this.origin,
      ...(token ? { token } : {}),
      fetch: this.fetchImpl,
      clientId: this.clientId,
      headers: this.extraHeaders,
    });
  }

  url(path: string, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    return `${this.origin}${path}${s ? `?${s}` : ""}`;
  }

  /** Low-level request: returns the raw `Response` (no status check). */
  async raw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...this.extraHeaders };
    if (this.token && !opts.anonymous) headers["authorization"] = `Bearer ${this.token}`;
    let body: RequestInit["body"] | undefined = opts.body;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    Object.assign(headers, opts.headers ?? {});
    return this.fetchImpl(this.url(path, opts.query), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(opts.redirect ? { redirect: opts.redirect } : {}),
    });
  }

  /** Sends a request and parses the answer: JSON → object, 204 → undefined, other → text. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (!res.ok) throw await FabplaneApiError.fromResponse(res, method, path);
    return (await parseBody(res)) as T;
  }

  /* ================= Me ================= */

  /** `GET /v1/private/me` [getMe] */
  getMe(): Promise<MeResponse> {
    return this.request("GET", "/v1/private/me");
  }

  /* ================= Tokens ================= */

  /** `GET /v1/private/tokens` [listTokens] */
  listTokens(): Promise<{ tokens: ApiToken[] }> {
    return this.request("GET", "/v1/private/tokens");
  }
  /** `POST /v1/private/tokens` [createToken]: the `secret` is shown only once. */
  createToken(body: CreateTokenInput): Promise<{ token: ApiToken; secret: string }> {
    return this.request("POST", "/v1/private/tokens", { json: body });
  }
  /** `DELETE /v1/private/tokens/:tokenId` [deleteToken] */
  deleteToken(tokenId: string): Promise<void> {
    return this.request("DELETE", `/v1/private/tokens/${enc(tokenId)}`);
  }

  /* ================= Orgs ================= */

  /** `GET /v1/private/orgs` [listOrgs]: the caller's memberships, personal org included. */
  listOrgs(): Promise<{ orgs: Org[] }> {
    return this.request("GET", "/v1/private/orgs");
  }
  /** `POST /v1/private/orgs` [createOrg] */
  createOrg(body: CreateOrgInput): Promise<{ org: Org }> {
    return this.request("POST", "/v1/private/orgs", { json: body });
  }
  /** `GET /v1/private/orgs/:orgId` [getOrg] */
  getOrg(orgId: string): Promise<{ org: Org }> {
    return this.request("GET", `/v1/private/orgs/${enc(orgId)}`);
  }
  /** `PATCH /v1/private/orgs/:orgId` [updateOrg] */
  updateOrg(orgId: string, patch: UpdateOrgInput): Promise<{ org: Org }> {
    return this.request("PATCH", `/v1/private/orgs/${enc(orgId)}`, { json: patch });
  }
  /** `DELETE /v1/private/orgs/:orgId` [deleteOrg] */
  deleteOrg(orgId: string): Promise<void> {
    return this.request("DELETE", `/v1/private/orgs/${enc(orgId)}`);
  }
  /** `GET /v1/private/orgs/joinable` [listJoinableOrgs] */
  listJoinableOrgs(): Promise<{ orgs: OrgSummary[] }> {
    return this.request("GET", "/v1/private/orgs/joinable");
  }
  /** `POST /v1/private/orgs/:orgId/join` [joinOrg] */
  joinOrg(orgId: string): Promise<{ org: Org }> {
    return this.request("POST", `/v1/private/orgs/${enc(orgId)}/join`);
  }

  /* ================= Members ================= */

  /** `GET /v1/private/orgs/:orgId/members` [listMembers] */
  listMembers(orgId: string): Promise<{ members: Member[] }> {
    return this.request("GET", `/v1/private/orgs/${enc(orgId)}/members`);
  }
  /** `PATCH /v1/private/orgs/:orgId/members/:userId` [updateMember] */
  updateMember(orgId: string, userId: string, body: { role: Role }): Promise<{ member: Member }> {
    return this.request("PATCH", `/v1/private/orgs/${enc(orgId)}/members/${enc(userId)}`, { json: body });
  }
  /** `DELETE /v1/private/orgs/:orgId/members/:userId` [removeMember] (your own id = leave) */
  removeMember(orgId: string, userId: string): Promise<void> {
    return this.request("DELETE", `/v1/private/orgs/${enc(orgId)}/members/${enc(userId)}`);
  }

  /* ================= Invites ================= */

  /** `GET /v1/private/orgs/:orgId/invites` [listInvites] */
  listInvites(orgId: string): Promise<{ invites: Invite[] }> {
    return this.request("GET", `/v1/private/orgs/${enc(orgId)}/invites`);
  }
  /** `POST /v1/private/orgs/:orgId/invites` [createInvite]: returns a copyable `invite.url`. */
  createInvite(orgId: string, body: CreateInviteInput = {}): Promise<{ invite: Invite }> {
    return this.request("POST", `/v1/private/orgs/${enc(orgId)}/invites`, { json: body });
  }
  /** `DELETE /v1/private/orgs/:orgId/invites/:inviteId` [revokeInvite] */
  revokeInvite(orgId: string, inviteId: string): Promise<void> {
    return this.request("DELETE", `/v1/private/orgs/${enc(orgId)}/invites/${enc(inviteId)}`);
  }
  /** `GET /v1/private/invites/:token` [getInvite] */
  getInvite(token: string): Promise<{ invite: InvitePreview }> {
    return this.request("GET", `/v1/private/invites/${enc(token)}`);
  }
  /** `POST /v1/private/invites/:token/accept` [acceptInvite] */
  acceptInvite(token: string): Promise<{ org: Org }> {
    return this.request("POST", `/v1/private/invites/${enc(token)}/accept`);
  }

  /* ================= Destinations ================= */

  /** `GET /v1/private/orgs/:orgId/destinations` [listDestinations]: built-ins first. */
  listDestinations(orgId: string): Promise<{ destinations: Destination[] }> {
    return this.request("GET", `/v1/private/orgs/${enc(orgId)}/destinations`);
  }
  /** `POST /v1/private/orgs/:orgId/destinations` [createDestination] */
  createDestination(orgId: string, body: CreateDestinationInput): Promise<{ destination: Destination }> {
    return this.request("POST", `/v1/private/orgs/${enc(orgId)}/destinations`, { json: body });
  }
  /** `DELETE /v1/private/orgs/:orgId/destinations/:destinationId` [deleteDestination] */
  deleteDestination(orgId: string, destinationId: string): Promise<void> {
    return this.request("DELETE", `/v1/private/orgs/${enc(orgId)}/destinations/${enc(destinationId)}`);
  }

  /* ================= Carts ================= */

  private cartPath(orgId: string, cartId?: string): string {
    return `/v1/private/orgs/${enc(orgId)}/carts${cartId !== undefined ? `/${enc(cartId)}` : ""}`;
  }

  /** `GET /v1/private/orgs/:orgId/carts` [listCarts]; `repo` matches any tagged repo (normalized). */
  listCarts(orgId: string, query: ListCartsQuery = {}): Promise<{ carts: CartSummary[] }> {
    return this.request("GET", this.cartPath(orgId), { query: { repo: query.repo, projectId: query.projectId } });
  }
  /** `POST /v1/private/orgs/:orgId/carts` [createCart] */
  createCart(orgId: string, body: CreateCartInput): Promise<{ cart: Cart }> {
    return this.request("POST", this.cartPath(orgId), { json: body });
  }
  /** `GET /v1/private/orgs/:orgId/carts/:cartId` [getCart] */
  getCart(orgId: string, cartId: string): Promise<{ cart: Cart }> {
    return this.request("GET", this.cartPath(orgId, cartId));
  }
  /** `PATCH /v1/private/orgs/:orgId/carts/:cartId` [updateCart] */
  updateCart(orgId: string, cartId: string, patch: UpdateCartInput): Promise<{ cart: Cart }> {
    return this.request("PATCH", this.cartPath(orgId, cartId), { json: patch });
  }
  /** `DELETE /v1/private/orgs/:orgId/carts/:cartId` [deleteCart] */
  deleteCart(orgId: string, cartId: string): Promise<void> {
    return this.request("DELETE", this.cartPath(orgId, cartId));
  }
  /** `POST /v1/private/orgs/:orgId/carts/:cartId/items` [addCartItems] (1..500 items) */
  addCartItems(orgId: string, cartId: string, items: CartItemInput[]): Promise<{ items: CartItem[] }> {
    return this.request("POST", `${this.cartPath(orgId, cartId)}/items`, { json: { items } });
  }
  /** `PUT /v1/private/orgs/:orgId/carts/:cartId/items` [replaceCartItems]: replaces every item (BOM sync). */
  replaceCartItems(orgId: string, cartId: string, items: CartItemInput[], source?: string): Promise<{ cart: Cart }> {
    return this.request("PUT", `${this.cartPath(orgId, cartId)}/items`, {
      json: { items, ...(source !== undefined ? { source } : {}) },
    });
  }
  /** `PATCH /v1/private/orgs/:orgId/carts/:cartId/items/:itemId` [updateCartItem] */
  updateCartItem(orgId: string, cartId: string, itemId: string, patch: Partial<CartItemInput>): Promise<{ item: CartItem }> {
    return this.request("PATCH", `${this.cartPath(orgId, cartId)}/items/${enc(itemId)}`, { json: patch });
  }
  /** `DELETE /v1/private/orgs/:orgId/carts/:cartId/items/:itemId` [deleteCartItem] */
  deleteCartItem(orgId: string, cartId: string, itemId: string): Promise<void> {
    return this.request("DELETE", `${this.cartPath(orgId, cartId)}/items/${enc(itemId)}`);
  }
  /** `GET /v1/private/orgs/:orgId/carts/:cartId/export.csv` [exportCartCsv]: CSV text. */
  exportCartCsv(orgId: string, cartId: string, query: { destinationId?: string } = {}): Promise<string> {
    return this.request("GET", `${this.cartPath(orgId, cartId)}/export.csv`, {
      query: { destinationId: query.destinationId },
      headers: { accept: "text/csv" },
    });
  }

  /* ================= Inventory ================= */

  private inventoryPath(orgId: string, itemId?: string): string {
    return `/v1/private/orgs/${enc(orgId)}/inventory${itemId !== undefined ? `/${enc(itemId)}` : ""}`;
  }

  /** `GET /v1/private/orgs/:orgId/inventory` [listInventory] */
  listInventory(orgId: string, query: ListInventoryQuery = {}): Promise<{ items: InventoryItem[]; nextCursor: string | null }> {
    return this.request("GET", this.inventoryPath(orgId), { query: { ...query } });
  }
  /**
   * `POST /v1/private/orgs/:orgId/inventory` [createInventoryItem]. JSON without images;
   * `multipart/form-data` (`item` JSON field + `image` files) with them. `serverAiProcessing: true`
   * is answered with 501 `server_ai_unavailable`: extract fields locally and send them instead.
   */
  createInventoryItem(orgId: string, input: InventoryItemInput, images?: ImageUpload[]): Promise<{ item: InventoryItem }> {
    if (!images || images.length === 0) {
      return this.request("POST", this.inventoryPath(orgId), { json: input });
    }
    const form = new FormData();
    form.append("item", JSON.stringify(input));
    images.forEach((image, i) => {
      form.append("image", toBlob(image), image.filename ?? `image-${i + 1}.${extensionFor(image.contentType)}`);
    });
    return this.request("POST", this.inventoryPath(orgId), { body: form });
  }
  /** `POST /v1/private/orgs/:orgId/inventory/bulk` [bulkUpsertInventory] (1..500, upsert by `externalId`) */
  bulkUpsertInventory(orgId: string, items: InventoryItemInput[]): Promise<{ items: InventoryItem[]; created: number; updated: number }> {
    return this.request("POST", `${this.inventoryPath(orgId)}/bulk`, { json: { items } });
  }
  /** `GET /v1/private/orgs/:orgId/inventory/:itemId` [getInventoryItem] */
  getInventoryItem(orgId: string, itemId: string): Promise<{ item: InventoryItem }> {
    return this.request("GET", this.inventoryPath(orgId, itemId));
  }
  /** `PATCH /v1/private/orgs/:orgId/inventory/:itemId` [updateInventoryItem] */
  updateInventoryItem(orgId: string, itemId: string, patch: Partial<InventoryItemInput>): Promise<{ item: InventoryItem }> {
    return this.request("PATCH", this.inventoryPath(orgId, itemId), { json: patch });
  }
  /** `DELETE /v1/private/orgs/:orgId/inventory/:itemId` [deleteInventoryItem] */
  deleteInventoryItem(orgId: string, itemId: string): Promise<void> {
    return this.request("DELETE", this.inventoryPath(orgId, itemId));
  }
  /** `POST /v1/private/orgs/:orgId/inventory/:itemId/adjust` [adjustInventory]: atomic; 409 below zero. */
  adjustInventory(orgId: string, itemId: string, delta: number, reason?: string): Promise<{ item: InventoryItem }> {
    return this.request("POST", `${this.inventoryPath(orgId, itemId)}/adjust`, {
      json: { delta, ...(reason !== undefined ? { reason } : {}) },
    });
  }
  /**
   * `POST /v1/private/orgs/:orgId/inventory/:itemId/images` [uploadInventoryImage] (multipart `image`).
   * `source` (e.g. `web`) and `sourceUrl` (the page it came from) are stored on the image.
   */
  uploadInventoryImage(orgId: string, itemId: string, image: ImageUpload, options: UploadImageOptions = {}): Promise<{ image: InventoryImage }> {
    const form = new FormData();
    form.append("image", toBlob(image), image.filename ?? `image.${extensionFor(image.contentType)}`);
    if (options.source !== undefined) form.append("source", options.source);
    if (options.sourceUrl !== undefined) form.append("sourceUrl", options.sourceUrl);
    return this.request("POST", `${this.inventoryPath(orgId, itemId)}/images`, { body: form });
  }
  /**
   * `GET /v1/private/orgs/:orgId/inventory/:itemId/images/:imageId` [getInventoryImage]:
   * the API answers 302 to a 15-minute signed URL, which is returned without following it.
   */
  async getInventoryImage(orgId: string, itemId: string, imageId: string): Promise<{ url: string }> {
    const path = `${this.inventoryPath(orgId, itemId)}/images/${enc(imageId)}`;
    const res = await this.raw("GET", path, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      return { url: new URL(location, this.origin).toString() };
    }
    if (!res.ok) throw await FabplaneApiError.fromResponse(res, "GET", path);
    // A fetch that followed the redirect anyway: the final URL is the signed one.
    await res.body?.cancel().catch(() => undefined);
    return { url: res.url || this.url(path) };
  }
  /** `DELETE /v1/private/orgs/:orgId/inventory/:itemId/images/:imageId` [deleteInventoryImage] */
  deleteInventoryImage(orgId: string, itemId: string, imageId: string): Promise<void> {
    return this.request("DELETE", `${this.inventoryPath(orgId, itemId)}/images/${enc(imageId)}`);
  }

  /* ================= Inventory photo queue (v1.1) ================= */

  /**
   * `GET /v1/private/orgs/:orgId/inventory/photo-queue` [listPhotoQueue]: items with no image that
   * are not skipped. `include: "available"` (default) hides leased items; `"all"` shows them.
   */
  listPhotoQueue(
    orgId: string,
    query: ListPhotoQueueQuery = {},
  ): Promise<{ items: PhotoQueueItem[]; nextCursor: string | null; counts: PhotoQueueCounts }> {
    return this.request("GET", `${this.inventoryPath(orgId)}/photo-queue`, { query: { ...query } });
  }
  /**
   * `POST /v1/private/orgs/:orgId/inventory/photo-queue/claim` [claimPhotoQueue]: atomically leases up
   * to `limit` items (1..25, default 5) for `leaseSeconds` (60..3600, default 900).
   */
  claimPhotoQueue(orgId: string, body: ClaimPhotoQueueInput = {}): Promise<{ items: ClaimedPhotoQueueItem[]; leaseUntil: string }> {
    return this.request("POST", `${this.inventoryPath(orgId)}/photo-queue/claim`, { json: body });
  }
  /**
   * `POST /v1/private/orgs/:orgId/inventory/:itemId/photo-queue/release` [releasePhotoQueueItem]:
   * `retry` returns the item to the queue; `not_found` marks it skipped with the note. Pass the
   * `leaseToken` from the claim: under an active lease a missing or wrong token is a 409 `conflict`
   * (another worker reclaimed the item; leave it alone).
   */
  releasePhotoQueueItem(orgId: string, itemId: string, body: ReleasePhotoQueueInput): Promise<{ item: PhotoQueueItem }> {
    return this.request("POST", `${this.inventoryPath(orgId, itemId)}/photo-queue/release`, { json: body });
  }
  /** `POST /v1/private/orgs/:orgId/inventory/:itemId/photo-queue/requeue` [requeuePhotoQueueItem] (admin) */
  requeuePhotoQueueItem(orgId: string, itemId: string): Promise<{ item: PhotoQueueItem }> {
    return this.request("POST", `${this.inventoryPath(orgId, itemId)}/photo-queue/requeue`);
  }

  /* ================= Bot accounts (v1.2) ================= */

  /** `POST /v1/auth/bot/connect` [startBotConnect] (anonymous): a link + code for an org admin to approve. */
  startBotConnect(body: StartBotConnectInput): Promise<BotConnectStart> {
    return this.request("POST", "/v1/auth/bot/connect", { anonymous: true, json: { clientId: this.clientId, ...body } });
  }

  /**
   * One `POST /v1/auth/bot/token` poll [pollBotConnect] (anonymous). `authorization_pending`,
   * `slow_down`, `access_denied` and `expired_token` resolve; other failures throw.
   */
  async pollBotConnect(connectCode: string): Promise<BotConnectPollOutcome> {
    const path = "/v1/auth/bot/token";
    const res = await this.raw("POST", path, { anonymous: true, json: { connectCode } });
    if (res.ok) {
      const body = (await res.json()) as Partial<BotConnectToken>;
      if (typeof body.accessToken !== "string" || !body.accessToken || !body.bot) {
        throw new FabplaneApiError({ status: res.status, code: "invalid_response", message: "Bot token response has no accessToken", body, method: "POST", path });
      }
      return { status: "token", token: body as BotConnectToken };
    }
    if ([400, 401, 403, 428, 429].includes(res.status)) {
      const err = await FabplaneApiError.fromResponse(res, "POST", path);
      if (err.code === "authorization_pending" || (res.status === 428 && err.code === "http_428")) return { status: "pending" };
      if (err.code === "slow_down" || (res.status === 429 && err.code === "http_429")) return { status: "slow_down" };
      const b = err.body as Record<string, unknown> | undefined;
      const description = b && typeof b["message"] === "string" ? b["message"] : undefined;
      return { status: "error", error: err.code, ...(description ? { description } : {}) };
    }
    throw await FabplaneApiError.fromResponse(res, "POST", path);
  }

  /**
   * Polls until an admin approves or denies the connect request, or it expires (honouring
   * `interval` and `slow_down`). Throws `FabplaneApiError` with code `access_denied` /
   * `expired_token` for those outcomes.
   */
  async waitForBotConnect(
    start: BotConnectStart,
    opts: { signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; onPoll?: (outcome: BotConnectPollOutcome) => void } = {},
  ): Promise<BotConnectToken> {
    const sleep = opts.sleep ?? sleepMs;
    const now = opts.now ?? Date.now;
    const deadline = now() + start.expiresIn * 1000;
    let interval = Math.max(1, start.interval);
    const path = "/v1/auth/bot/token";
    for (;;) {
      await sleep(interval * 1000, opts.signal);
      if (opts.signal?.aborted) throw new FabplaneApiError({ status: 0, code: "aborted", message: "Bot connect cancelled", body: null, method: "POST", path });
      const outcome = await this.pollBotConnect(start.connectCode);
      opts.onPoll?.(outcome);
      if (outcome.status === "token") return outcome.token;
      if (outcome.status === "slow_down") interval += 5;
      if (outcome.status === "error") {
        const message =
          outcome.error === "access_denied"
            ? "The connect request was denied in the dashboard."
            : outcome.error === "expired_token"
              ? "The connect request expired (or its token was already collected). Run `fabplane bot connect` again."
              : `Bot connect failed: ${outcome.description ?? outcome.error}`;
        throw new FabplaneApiError({ status: 400, code: outcome.error, message, body: outcome, method: "POST", path });
      }
      if (now() > deadline) {
        throw new FabplaneApiError({ status: 400, code: "expired_token", message: "The connect request expired before anyone approved it. Run `fabplane bot connect` again.", body: null, method: "POST", path });
      }
    }
  }

  /** `GET /v1/private/bots/connect/:userCode` [getBotConnectRequest] (signed-in human) */
  getBotConnectRequest(userCode: string): Promise<{ request: BotConnectRequest; orgs: OrgSummary[] }> {
    return this.request("GET", `/v1/private/bots/connect/${enc(userCode)}`);
  }
  /** `POST /v1/private/bots/connect/:userCode/approve` [approveBotConnect] (admin of `orgId`) */
  approveBotConnect(userCode: string, body: { orgId: string; role?: "member" | "admin" }): Promise<{ bot: Bot }> {
    return this.request("POST", `/v1/private/bots/connect/${enc(userCode)}/approve`, { json: body });
  }
  /** `POST /v1/private/bots/connect/:userCode/deny` [denyBotConnect] */
  denyBotConnect(userCode: string): Promise<void> {
    return this.request("POST", `/v1/private/bots/connect/${enc(userCode)}/deny`);
  }
  /** `GET /v1/private/orgs/:orgId/bots` [listBots] (admin) */
  listBots(orgId: string): Promise<{ bots: Bot[] }> {
    return this.request("GET", `/v1/private/orgs/${enc(orgId)}/bots`);
  }
  /** `POST /v1/private/orgs/:orgId/bots` [createBot] (admin): the `fpb_` token is shown once. */
  createBot(orgId: string, body: CreateBotInput): Promise<{ bot: Bot; token: string }> {
    return this.request("POST", `/v1/private/orgs/${enc(orgId)}/bots`, { json: body });
  }
  /** `POST /v1/private/orgs/:orgId/bots/:botId/tokens` [rotateBotToken] (admin): revokes the previous tokens. */
  rotateBotToken(orgId: string, botId: string): Promise<{ token: string }> {
    return this.request("POST", `/v1/private/orgs/${enc(orgId)}/bots/${enc(botId)}/tokens`);
  }
  /** `DELETE /v1/private/orgs/:orgId/bots/:botId` [deleteBot] (admin) */
  deleteBot(orgId: string, botId: string): Promise<void> {
    return this.request("DELETE", `/v1/private/orgs/${enc(orgId)}/bots/${enc(botId)}`);
  }

  /* ================= Existing endpoints (auth, settings, catalog, push) ================= */

  /** `POST /v1/auth/device/code`: starts an RFC 8628 device login. */
  async startDeviceLogin(opts: { clientLabel?: string; scope?: string } = {}): Promise<DeviceCodeResponse> {
    const body = await this.request<Partial<DeviceCodeResponse>>("POST", "/v1/auth/device/code", {
      anonymous: true,
      json: {
        client_id: this.clientId,
        client_label: opts.clientLabel ?? "fabplane-cli",
        ...(opts.scope ? { scope: opts.scope } : {}),
      },
    });
    if (!body || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
      throw new FabplaneApiError({
        status: 200,
        code: "invalid_response",
        message: "The device-code response is missing device_code/user_code",
        body,
        method: "POST",
        path: "/v1/auth/device/code",
      });
    }
    const verificationUri = body.verification_uri ?? "";
    return {
      device_code: body.device_code,
      user_code: body.user_code,
      verification_uri: verificationUri,
      verification_uri_complete: body.verification_uri_complete ?? verificationUri,
      expires_in: typeof body.expires_in === "number" ? body.expires_in : 900,
      interval: typeof body.interval === "number" ? body.interval : 5,
    };
  }

  /** One `POST /v1/auth/device/token` poll. The RFC 8628 error codes resolve; other failures throw. */
  async pollDeviceToken(deviceCode: string): Promise<DevicePollOutcome> {
    const path = "/v1/auth/device/token";
    const res = await this.raw("POST", path, {
      anonymous: true,
      json: { grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: this.clientId },
    });
    if (res.ok) {
      const token = (await res.json()) as Partial<DeviceTokenResponse>;
      if (typeof token.access_token !== "string" || !token.access_token) {
        throw new FabplaneApiError({ status: res.status, code: "invalid_response", message: "Token response has no access_token", body: token, method: "POST", path });
      }
      return {
        status: "token",
        token: {
          access_token: token.access_token,
          token_type: token.token_type ?? "Bearer",
          expires_in: typeof token.expires_in === "number" ? token.expires_in : 0,
        },
      };
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const err = await FabplaneApiError.fromResponse(res, "POST", path);
      if (err.code === "authorization_pending") return { status: "pending" };
      if (err.code === "slow_down") return { status: "slow_down" };
      const b = err.body as Record<string, unknown> | undefined;
      const description = b && typeof b["error_description"] === "string" ? b["error_description"] : undefined;
      return { status: "error", error: err.code, ...(description ? { description } : {}) };
    }
    throw await FabplaneApiError.fromResponse(res, "POST", path);
  }

  /**
   * Polls until the device login is approved, denied or expires (honouring `interval` and
   * `slow_down`). Resolves with the token response; throws `FabplaneApiError` otherwise.
   */
  async waitForDeviceToken(
    device: DeviceCodeResponse,
    opts: { signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number } = {},
  ): Promise<DeviceTokenResponse> {
    const sleep = opts.sleep ?? sleepMs;
    const now = opts.now ?? Date.now;
    const deadline = now() + device.expires_in * 1000;
    let interval = Math.max(1, device.interval);
    for (;;) {
      await sleep(interval * 1000, opts.signal);
      if (opts.signal?.aborted) {
        throw new FabplaneApiError({ status: 0, code: "aborted", message: "Login cancelled", body: null, method: "POST", path: "/v1/auth/device/token" });
      }
      const outcome = await this.pollDeviceToken(device.device_code);
      if (outcome.status === "token") return outcome.token;
      if (outcome.status === "slow_down") interval += 5;
      if (outcome.status === "error") {
        throw new FabplaneApiError({
          status: 400,
          code: outcome.error,
          message: outcome.description ?? (outcome.error === "expired_token" ? "The login code expired; run login again" : outcome.error === "access_denied" ? "Login was denied" : `Login failed: ${outcome.error}`),
          body: outcome,
          method: "POST",
          path: "/v1/auth/device/token",
        });
      }
      if (now() > deadline) {
        throw new FabplaneApiError({ status: 400, code: "expired_token", message: "The login code expired; run login again", body: null, method: "POST", path: "/v1/auth/device/token" });
      }
    }
  }

  /**
   * Password login for local/staging seed accounts: `POST /v1/auth/password` for a session
   * cookie, approve a fresh device code with it, then collect the device token. Refused against
   * production, where password login is disabled.
   */
  async loginWithPassword(credentials: { email: string; password: string }, opts: { clientLabel?: string } = {}): Promise<DeviceTokenResponse> {
    if (new URL(this.origin).hostname === "api.fabplane.com") {
      throw new FabplaneApiError({ status: 400, code: "password_login_unavailable", message: "Password login is not available on production. Use `fabplane login` (browser device flow) or a personal API token.", body: null, method: "POST", path: "/v1/auth/password" });
    }
    const device = await this.startDeviceLogin(opts.clientLabel ? { clientLabel: opts.clientLabel } : {});
    const res = await this.raw("POST", "/v1/auth/password", {
      anonymous: true,
      json: { email: credentials.email.trim(), password: credentials.password },
      redirect: "manual",
    });
    const cookies = cookiesFrom(res);
    if (res.status === 401 || !/(^|;\s*)fp_session=/.test(cookies)) {
      if (res.status >= 500) throw await FabplaneApiError.fromResponse(res, "POST", "/v1/auth/password");
      await res.body?.cancel().catch(() => undefined);
      throw new FabplaneApiError({ status: 401, code: "invalid_credentials", message: "Invalid email or password.", body: null, method: "POST", path: "/v1/auth/password" });
    }
    await res.body?.cancel().catch(() => undefined);
    await this.request("POST", "/v1/auth/device/approve", {
      anonymous: true,
      headers: { cookie: cookies },
      json: { user_code: device.user_code, decision: "approve" },
    });
    const outcome = await this.pollDeviceToken(device.device_code);
    if (outcome.status === "token") return outcome.token;
    return this.waitForDeviceToken(device);
  }

  /** `GET /v1/auth/me`: the signed-in user, or `{ user: null }`. */
  me(): Promise<AuthMeResponse> {
    return this.request("GET", "/v1/auth/me");
  }

  /** `DELETE /v1/auth/session`: revokes the current session/device token. */
  logout(): Promise<void> {
    return this.request("DELETE", "/v1/auth/session");
  }

  /** `GET /v1/private/settings`; `null` when nothing is stored (404). */
  async getSettings(): Promise<CloudSettings | null> {
    try {
      return await this.request<CloudSettings>("GET", "/v1/private/settings");
    } catch (err) {
      if (err instanceof FabplaneApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** `PUT /v1/private/settings` */
  putSettings(settings: CloudSettings): Promise<CloudSettings> {
    return this.request("PUT", "/v1/private/settings", { json: settings });
  }

  /** `GET /v1/public/catalog`: open-source project catalog (no auth). */
  publicCatalog(q?: string): Promise<PublicCatalog> {
    return this.request("GET", "/v1/public/catalog", { anonymous: true, query: { q: q?.trim() } });
  }

  /** `GET /v1/config`: public service configuration (no auth). */
  config(): Promise<PublicConfig> {
    return this.request("GET", "/v1/config", { anonymous: true });
  }

  /** `GET /v1/public/openapi.json`: the API's OpenAPI 3.1 document (no auth). */
  openapi(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/public/openapi.json", { anonymous: true });
  }

  /** `POST /v1/private/push`: queue push notifications to the caller's registered devices. */
  sendPush(messages: PushMessage[]): Promise<PushResponse> {
    return this.request("POST", "/v1/private/push", { json: { messages } });
  }

  /** `GET /v1/private/push/:jobId`: delivery verdict for a queued push batch. */
  getPushJob(jobId: string): Promise<PushJob> {
    return this.request("GET", `/v1/private/push/${enc(jobId)}`);
  }
}

/** Flattens a `getMe()` answer (current `{ principal, email, … }` or older `{ user }`). */
export function meUser(me: MeResponse | AuthMeResponse | null | undefined): MeUser | null {
  if (!me) return null;
  const m = me as MeResponse;
  const base = m.principal ?? m.user ?? null;
  if (!base) return null;
  return {
    ...base,
    ...(m.bot ? { bot: m.bot, kind: "bot" as const } : {}),
    ...(m.email !== undefined ? { email: m.email } : {}),
    ...(m.emailVerified !== undefined ? { emailVerified: m.emailVerified } : {}),
    ...(m.personalOrgId !== undefined ? { personalOrgId: m.personalOrgId } : {}),
  };
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return JSON.parse(text);
  return text;
}

function cookiesFrom(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const parts = list.map((c) => c.split(";")[0]?.trim()).filter((c): c is string => Boolean(c));
  if (parts.length === 0) {
    const single = res.headers.get("set-cookie")?.split(";")[0]?.trim();
    if (single) parts.push(single);
  }
  return parts.join("; ");
}

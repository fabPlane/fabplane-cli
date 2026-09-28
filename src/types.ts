/** Wire types for the fabplane.com v1 API (orgs, tokens, carts, inventory). JSON is camelCase. */

export type Role = "owner" | "admin" | "member";

export type MeResponse = {
  user: {
    subject: string;
    handle?: string;
    displayName?: string;
    email?: string | null;
    emailVerified?: boolean;
    personalOrgId?: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

export type ApiToken = {
  id: string;
  name: string;
  /** First 12 characters of the secret, for recognising it later. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};
export type CreateTokenInput = { name: string; expiresInDays?: number };

export type DomainJoin = { domain: string; enabled: boolean };

export type Org = {
  id: string;
  slug: string;
  name: string;
  personal: boolean;
  role: Role;
  memberCount: number;
  domainJoin: DomainJoin | null;
  createdAt: string;
};
export type OrgSummary = { id: string; slug: string; name: string; memberCount: number };
export type CreateOrgInput = { name: string; slug?: string };
export type UpdateOrgInput = { name?: string; domainJoin?: DomainJoin | null };

export type Member = {
  userId: string;
  handle: string;
  displayName: string;
  email: string | null;
  role: Role;
  joinedAt: string;
};

export type Invite = {
  id: string;
  email: string | null;
  role: Role;
  token: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
};
export type CreateInviteInput = { email?: string; role?: "admin" | "member"; expiresInDays?: number };
export type InvitePreview = {
  orgId: string;
  orgName: string;
  role: Role;
  email: string | null;
  expiresAt: string;
};

export type DestinationKind = "fab" | "distributor" | "manual";
export type Destination = {
  id: string;
  name: string;
  kind: DestinationKind;
  url: string | null;
  builtin: boolean;
  baseId: string | null;
};
export type CreateDestinationInput = {
  name: string;
  url: string;
  kind?: DestinationKind;
  baseId?: string;
};

export type CartItemKind = "pcb" | "part" | "other";
export type CartItemStatus = "needed" | "ordered" | "received";

export type CartItemInput = {
  kind?: CartItemKind;
  mpn?: string;
  manufacturer?: string;
  description?: string;
  value?: string;
  footprint?: string;
  refs?: string[];
  quantity: number;
  destinationId?: string;
  sku?: string;
  url?: string;
  unitPrice?: number;
  currency?: string;
  status?: CartItemStatus;
  notes?: string;
  inventoryItemId?: string | null;
};

export type CartItem = Omit<CartItemInput, "kind" | "quantity" | "status" | "destinationId"> & {
  id: string;
  kind: CartItemKind;
  quantity: number;
  status: CartItemStatus;
  destinationId: string;
  createdAt: string;
  updatedAt: string;
};

export type CartSummary = {
  id: string;
  orgId: string;
  name: string;
  repos: string[];
  projectId: string | null;
  fabDestinationId: string;
  itemCount: number;
  updatedAt: string;
  createdAt: string;
};

export type Cart = CartSummary & {
  notes: string | null;
  items: CartItem[];
  byDestination: { destinationId: string; itemCount: number; totalQuantity: number }[];
};

export type CreateCartInput = {
  name: string;
  repos?: string[];
  projectId?: string;
  notes?: string;
  fabDestinationId?: string;
};
export type UpdateCartInput = {
  name?: string;
  repos?: string[];
  projectId?: string | null;
  notes?: string;
  fabDestinationId?: string;
};
export type ListCartsQuery = { repo?: string; projectId?: string };

export type AttributeValue = string | number | boolean | null;

export type InventoryItemInput = {
  name: string;
  mpn?: string;
  manufacturer?: string;
  sku?: string;
  category?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  location?: string;
  tags?: string[];
  attributes?: Record<string, AttributeValue>;
  source?: string;
  externalId?: string;
  /** `true` asks the server to run AI extraction: answered with 501 `server_ai_unavailable` for now. */
  serverAiProcessing?: boolean;
};

export type InventoryImage = {
  id: string;
  contentType: string;
  bytes: number;
  url: string;
  createdAt: string;
};

export type InventoryItem = Omit<InventoryItemInput, "serverAiProcessing" | "quantity" | "unit" | "tags" | "attributes"> & {
  id: string;
  orgId: string;
  quantity: number;
  unit: string;
  tags: string[];
  attributes: Record<string, unknown>;
  images: InventoryImage[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ListInventoryQuery = {
  q?: string;
  category?: string;
  location?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
};

/** An image to upload: raw bytes or a Blob, with its media type and a filename. */
export type ImageUpload = {
  data: Uint8Array | ArrayBuffer | Blob;
  contentType: string;
  filename?: string;
};

/* ---------- existing (pre-contract) endpoints ---------- */

/** RFC 8628 device authorization response (`POST /v1/auth/device/code`). */
export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type DeviceTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

export type DevicePollOutcome =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "token"; token: DeviceTokenResponse }
  | { status: "error"; error: string; description?: string };

/** `GET /v1/auth/me`. */
export type AuthMeResponse = {
  user: { subject: string; handle?: string; displayName?: string; email?: string } | null;
};

/** `GET/PUT /v1/private/settings`: the account's synced app settings (opaque to this client). */
export type CloudSettings = { schema: number; updatedAt: number; [key: string]: unknown };

/** `GET /v1/public/catalog`: the open-source project catalog. */
export type PublicCatalog = { projects: Array<Record<string, unknown>>; [key: string]: unknown };

/** `GET /v1/config`: public service configuration (e.g. which relay serves this API). */
export type PublicConfig = { relayUrl?: string; relay?: { url?: string } | null; [key: string]: unknown };

export type PushMessage = {
  to: string;
  tokenKind?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};
export type PushTicket =
  | { status: "ok"; id?: string }
  | { status: "error"; message?: string; details?: { error?: string } };
export type PushResponse = { tickets: PushTicket[]; queued?: { jobId: string } | null };
export type PushJob = {
  status: "queued" | "running" | "completed" | "failed" | string;
  outcomes: Array<{ index: number; outcome: string; error?: string }>;
  [key: string]: unknown;
};

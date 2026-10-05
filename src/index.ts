export { FabplaneClient, meUser, DEFAULT_CLIENT_ID, DEVICE_GRANT_TYPE, type FabplaneClientOptions, type FetchLike } from "./client.js";
export { FabplaneApiError, isFabplaneApiError } from "./errors.js";
export { DEFAULT_API_ORIGIN, dashboardUrlFor, normalizeOrigin } from "./origin.js";
export {
  CredentialStore,
  configDir,
  credentialsPath,
  findOrg,
  looksLikeId,
  resolveAuth,
  resolveDefaultOrg,
  tokenKindOf,
  type CredentialsFile,
  type Env,
  type Profile,
  type ResolvedAuth,
} from "./credentials.js";
export {
  FabdeskClient,
  FabdeskError,
  appDataDir,
  daemonFileCandidates,
  fabdeskHome,
  findDaemonHandshake,
  type DaemonHandshake,
  type FabdeskAuthState,
  type FabdeskClientOptions,
  type FabdeskHealth,
  type FabdeskJob,
  type FabdeskLiveRun,
  type FabdeskProject,
  type FabdeskThread,
  type FabdeskToolManifestEntry,
  type FabdeskToolResult,
} from "./fabdesk.js";
export {
  fabplaneTools,
  desktopTools,
  FABPLANE_TOOL_NAMES,
  type DesktopTool,
  type FabplaneTool,
  type ToolAnnotations,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "./tools.js";
export { createFabplaneMcpServer, runMcpStdio, toCallToolResult, MCP_INSTRUCTIONS, type FabplaneMcpOptions } from "./mcp.js";
export { runCli, helpText, commandTable, type CliIo } from "./cli/run.js";
export { DEFAULT_IMAGE_TIMEOUT_MS, IMAGE_CONTENT_TYPES, ImageFetchError, MAX_IMAGE_BYTES, fetchImage, imageFromBase64, sniffImageType, validateImage } from "./images.js";
export { cartItemsFromCsv, cartItemsFromJson, parseCsv, parseJsonl } from "./csv.js";
export { operations, type OperationInfo } from "./generated/operations.js";
export { VERSION } from "./version.js";
export type * from "./types.js";

export {boardInput as pcbBoardInputSchema,revisionInput as pcbRevisionInputSchema,revisionUpdate as pcbRevisionUpdateSchema,orderInput as pcbOrderInputSchema,orderUpdate as pcbOrderUpdateSchema,importPreviewInput as pcbImportPreviewSchema} from './pcb.js';
export type {Workflow as PcbWorkflow,Board as PcbBoard,Revision as PcbRevision,Order as PcbOrder} from './pcb.js';

export type PcbBoardInput = import('zod/v4').input<typeof import('./pcb.js').boardInput>;
export type PcbRevisionInput = import('zod/v4').input<typeof import('./pcb.js').revisionInput>;
export type PcbOrderInput = import('zod/v4').input<typeof import('./pcb.js').orderInput>;
export type PcbRevisionUpdate = import('zod/v4').input<typeof import('./pcb.js').revisionUpdate>;
export type PcbOrderUpdate = import('zod/v4').input<typeof import('./pcb.js').orderUpdate>;

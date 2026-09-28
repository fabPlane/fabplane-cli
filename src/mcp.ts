/** `fabplane mcp`: an MCP server exposing `fabplaneTools` (and the desktop tools with `--desktop`). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { FabplaneClient } from "./client.js";
import type { FabdeskClient } from "./fabdesk.js";
import { desktopTools, fabplaneTools, type ToolDef, type ToolResult } from "./tools.js";
import { VERSION } from "./version.js";

export interface FabplaneMcpOptions {
  client: FabplaneClient;
  /** Default org, or a function that resolves it on the first call that needs it. */
  orgId?: string | (() => Promise<string>);
  /** Also expose `desktop_*` tools over this fabdesk client. */
  desktop?: FabdeskClient;
  name?: string;
}

type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function toCallToolResult(result: ToolResult): CallToolResult {
  const content: CallToolResult["content"] = [];
  if (result.text !== undefined) content.push({ type: "text", text: result.text });
  if (result.json !== undefined) content.push({ type: "text", text: JSON.stringify(result.json, null, 2) });
  if (content.length === 0) content.push({ type: "text", text: "ok" });
  return { content, ...(result.isError ? { isError: true } : {}) };
}

export const MCP_INSTRUCTIONS =
  "Tools for fabplane.com: orgs, carts (shopping lists / BOMs with per-item purchase destinations) and the parts inventory. " +
  "Tools default to the user's default org; call org_list to see others. Inventory data should be extracted locally and sent as structured fields.";

export function createFabplaneMcpServer(opts: FabplaneMcpOptions): McpServer {
  const server = new McpServer(
    { name: opts.name ?? "fabplane", version: VERSION },
    { instructions: MCP_INSTRUCTIONS + (opts.desktop ? " desktop_* tools reach the local fabPlane desktop app." : "") },
  );
  let orgPromise: Promise<string | undefined> | null = null;
  const resolveOrg = (): Promise<string | undefined> => {
    if (typeof opts.orgId === "string" || opts.orgId === undefined) return Promise.resolve(opts.orgId);
    const fn = opts.orgId;
    orgPromise ??= fn().catch((err: unknown) => {
      orgPromise = null;
      throw err;
    });
    return orgPromise;
  };

  const register = <C>(tool: ToolDef<C>, target: C, needsOrg: boolean) => {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (async (args: Record<string, unknown>) => {
        let orgId: string | undefined;
        if (needsOrg && typeof args["orgId"] !== "string") {
          try {
            orgId = await resolveOrg();
          } catch (err) {
            return toCallToolResult({ isError: true, text: `Could not determine the default org: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        const result = await tool.handler(target, args as never, { orgId });
        return toCallToolResult(result);
      }) as never,
    );
  };

  for (const tool of fabplaneTools) register(tool, opts.client, tool.name !== "org_list");
  if (opts.desktop) for (const tool of desktopTools) register(tool, opts.desktop, false);
  return server;
}

/** Serves the MCP server over stdio until stdin closes. */
export async function runMcpStdio(opts: FabplaneMcpOptions): Promise<void> {
  const server = createFabplaneMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
  });
}

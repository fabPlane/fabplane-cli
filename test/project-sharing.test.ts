import assert from "node:assert/strict";
import { it } from "node:test";
import { FabplaneClient, FabplaneApiError } from "../src/index.js";

it("keeps owner mutations authenticated and public reads anonymous", async () => {
  const calls: Array<{url: string; init: RequestInit}> = [];
  const client = new FabplaneClient({token: "owner-secret", fetch: async (url, init) => {
    calls.push({url, init: init ?? {}});
    return Response.json({visibility: "private"});
  }});
  await client.getProjectShare("project/a");
  await client.publishProjectShare("project/a", {schema: 1});
  await client.disableProjectShare("project/a");
  await client.getSharedProject("share-id");
  assert.deepEqual(calls.map(c => c.init.method), ["GET", "PUT", "DELETE", "GET"]);
  assert.ok(calls[0]!.url.endsWith("/project-shares/project%2Fa"));
  for (const c of calls.slice(0, 3)) assert.equal((c.init.headers as Record<string,string>)["authorization"], "Bearer owner-secret");
  assert.equal((calls[3]!.init.headers as Record<string,string>)["authorization"], undefined);
});
it("does not manufacture a link when sharing is unavailable", async () => {
  const client = new FabplaneClient({fetch: async () => Response.json({error: "not_found"}, {status: 404})});
  await assert.rejects(client.publishProjectShare("p", {}), FabplaneApiError);
});

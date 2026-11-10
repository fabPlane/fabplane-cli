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
  await client.getSharedProjectStatus("share-id");
  assert.deepEqual(calls.map(c => c.init.method), ["GET", "PUT", "DELETE", "GET", "GET"]);
  assert.ok(calls[0]!.url.endsWith("/project-shares/project%2Fa"));
  for (const c of calls.slice(0, 3)) assert.equal((c.init.headers as Record<string,string>)["authorization"], "Bearer owner-secret");
  assert.ok(calls[4]!.url.endsWith("/project-shares/share-id/status"));
  assert.equal((calls[4]!.init.headers as Record<string,string>)["authorization"], undefined);
  assert.equal((calls[3]!.init.headers as Record<string,string>)["authorization"], undefined);
});
it("does not manufacture a link when sharing is unavailable", async () => {
  const client = new FabplaneClient({fetch: async () => Response.json({error: "not_found"}, {status: 404})});
  await assert.rejects(client.publishProjectShare("p", {}), FabplaneApiError);
});
it("publishes restricted snapshots explicitly and preserves default policy when no choice is supplied", async () => {
  const urls: string[] = [];
  const client = new FabplaneClient({token: "owner", fetch: async url => { urls.push(url); return Response.json({visibility: "restricted"}); }});
  await client.publishProjectShare("board project", {}, "restricted");
  await client.publishProjectShare("board project", {});
  assert.ok(new URL(urls[0]!).pathname.endsWith("/restricted"));
  assert.equal(new URL(urls[1]!).search, "");
});
it("updates snapshots through a fail-closed endpoint without resubmitting stale visibility", async () => {
  const urls: string[] = [];
  const client = new FabplaneClient({token: "owner", fetch: async url => { urls.push(url); return Response.json({error: "not_found"}, {status: 404}); }});
  await assert.rejects(client.publishProjectShare("board/project", {}, undefined, {updateOnly: true}), FabplaneApiError);
  assert.equal(urls.length, 1); // No legacy publication fallback on an older server.
  assert.ok(new URL(urls[0]!).pathname.endsWith("/board%2Fproject/snapshot"));
  assert.equal(new URL(urls[0]!).search, "");
  assert.throws(() => client.publishProjectShare("p", {}, "unlisted", {updateOnly: true}), TypeError);
  assert.equal(urls.length, 1);
});

it("keeps contributor downloads and guarded board writes authenticated without fallback", async () => {
  const calls: Array<{url:string; init:RequestInit}> = [];
  const c = new FabplaneClient({token:"member-token",fetch:async(url,init)=>{
    calls.push({url,init:init??{}}); return Response.json({error:"conflict",message:"Newer revision"},{status:409});
  }});
  await assert.rejects(c.listSharedProjects(),FabplaneApiError);
  await assert.rejects(c.listContributionBoards("p/x"),FabplaneApiError);
  await assert.rejects(c.downloadBoardSource("p/x","b/y"),FabplaneApiError);
  const input={expectedRevision:"old",files:{pcb:"(kicad_pcb )"}};
  await assert.rejects(c.publishBoardRevision("p/x","b/y",input),e=>e instanceof FabplaneApiError && e.status===409);
  assert.equal(calls.length,4);
  assert.ok(calls[2]!.url.endsWith("/p%2Fx/boards/b%2Fy/source"));
  assert.ok(calls[3]!.url.endsWith("/p%2Fx/boards/b%2Fy/revisions"));
  assert.deepEqual(JSON.parse(calls[3]!.init.body as string),input);
  for(const call of calls)assert.equal((call.init.headers as Record<string,string>).authorization,"Bearer member-token");
});

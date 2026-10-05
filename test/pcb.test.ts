import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {FabplaneClient,createFabplaneMcpServer,fabplaneTools,runCli} from '../src/index.js';
import {revisionInput,orderInput} from '../src/pcb.js';
const orgId='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
const evidence={source:'fixture',observedAt:'2026-10-05T00:00:00Z',verification:'unverified' as const,note:'Synthetic test'};
function fixture(status=200){const calls:Array<{url:string;init:RequestInit}>=[];return {calls,client:new FabplaneClient({origin:'http://127.0.0.1:4000',token:'fpk_fixture_no_live_token',fetch:async(url,init={})=>{calls.push({url,init});return new Response(JSON.stringify(status===200?{id,version:2,dryRun:true,mappings:[],boards:[],revisions:[],orders:[]}:{error:'not_found'}),{status,headers:{'content-type':'application/json'}})}})}}
test('SDK adds all seven scoped operations with strict local validation',async()=>{
 const {client,calls}=fixture();const revision=revisionInput.parse({key:'r1',label:'R1'}),order=orderInput.parse({key:'o1',vendor:'Test',reference:'Test',provenance:[evidence]});const {key,...update}=revision;
 await client.pcb_list(orgId);await client.pcb_create_board(orgId,{key:'b1',name:'Board'});await client.pcb_create_revision(orgId,id,revision);await client.pcb_update_revision(orgId,id,{...update,expectedVersion:1});await client.pcb_create_order(orgId,id,order);await client.pcb_update_order(orgId,id,{...order,expectedVersion:1});await client.pcb_import_preview(orgId,{candidates:[]});
 assert.equal(calls.length,7);assert.ok(calls.every(c=>c.url.includes(`/orgs/${orgId}/pcb`)));assert.equal(calls[3]!.init.method,'PUT');assert.equal(calls[6]!.init.method,'POST');
 const before=calls.length;assert.throws(()=>client.pcb_list('../../foreign'));assert.throws(()=>client.pcb_create_board(orgId,{key:'b1',name:'Board',bulk:[]} as any));assert.throws(()=>client.pcb_update_revision(orgId,id,{label:'R1',expectedVersion:1} as any));assert.throws(()=>client.pcb_update_order(orgId,id,{key:'o1',vendor:'Test',reference:'Test',provenance:[evidence],expectedVersion:1} as any));assert.equal(calls.length,before);
});
test('SDK propagates denial and never retries or broadens organization scope',async()=>{
 const {client,calls}=fixture(404);await assert.rejects(client.pcb_list(orgId),(e:any)=>e.status===404);await assert.rejects(client.pcb_create_board(orgId,{key:'b',name:'B'}),(e:any)=>e.status===404);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url.includes(orgId)));
});
test('official MCP exposes strict nested schemas, mutation hints and no bulk apply',async()=>{
 const {client,calls}=fixture();const server=createFabplaneMcpServer({client,orgId});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);const mcp=new Client({name:'pcb-fixture',version:'1'});await mcp.connect(ct);
 try{const listed=(await mcp.listTools()).tools.filter(t=>t.name.startsWith('pcb_'));assert.equal(listed.length,7);assert.equal(listed.find(t=>t.name==='pcb_import_preview')!.annotations!.readOnlyHint,true);assert.equal(listed.find(t=>t.name==='pcb_update_revision')!.annotations!.destructiveHint,true);
 const result=await mcp.callTool({name:'pcb_create_board',arguments:{orgId,board:{key:'b',name:'B',bulk:[]}}});assert.equal(result.isError,true);assert.equal(calls.length,0);
 const tool=fabplaneTools.find(t=>t.name==='pcb_create_board')!;const invalid=await tool.handler(client,{orgId,board:{key:'b',name:'B'},bulk:[]} as any,{});assert.equal(invalid.isError,true);assert.equal(calls.length,0);
 await mcp.callTool({name:'pcb_import_preview',arguments:{orgId,preview:{candidates:[]}}});assert.equal(calls.length,1);assert.ok(calls[0]!.url.endsWith('/import-preview'));
 }finally{await mcp.close();await server.close()}
});
test('CLI runs explicit single-record/preview commands with stdin; no writes on invalid body',async()=>{
 const calls:string[]=[],out:string[]=[],err:string[]=[];
 const io={env:{FABPLANE_TOKEN:'fpk_fixture_no_live_token',FABPLANE_API_ORIGIN:'http://127.0.0.1:4000',FABPLANE_ORG:orgId},stdout:(t:string)=>out.push(t),stderr:(t:string)=>err.push(t),readStdin:async()=>JSON.stringify({candidates:[]}),fetch:async(url:string)=>{calls.push(url);return new Response(JSON.stringify({dryRun:true,mappings:[]}),{headers:{'content-type':'application/json'}})}};
 assert.equal(await runCli(['pcb','import-preview','-','--org',orgId,'--json'],io),0,err.join('\n'));assert.equal(calls.length,1);assert.ok(calls[0]!.endsWith('/import-preview'));assert.equal(JSON.parse(out.join('\n')).dryRun,true);
 assert.notEqual(await runCli(['pcb','update-revision',id,'-','--org',orgId,'--json'],{...io,readStdin:async()=>JSON.stringify({label:'R1',expectedVersion:1})}),0);assert.equal(calls.length,1);
});

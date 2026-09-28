import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { HarnessError } from '../src/harness/model.ts';
import { prepareNewRequirement, getContinuationReceipt } from '../../companion-desktop/backend/yca-engineering-client.mjs';

test('companion endpoint exposes typed dispatch and no-ticket preparation actions', async t => {
  const calls: string[] = [];
  const manager: any = {closing:false,companionDispatch:{
    dispatch:async()=>{calls.push('dispatch');return {schema_version:1,operation_id:'one'};},
    get:()=>{calls.push('get');return {schema_version:1,operation_id:'one'};},
  },companionPreparation:{
    prepare:async()=>{calls.push('prepare');return {schema_version:1,preparation_id:'new'};},
    get:async()=>{calls.push('preparation-get');return {schema_version:1,preparation_id:'new'};},
  },companionContinuation:{
    advance:async()=>{calls.push('advance');return {schema_version:1,endpoint:'to-pr'};},
    get:async()=>{calls.push('continuation-get');return {schema_version:1,endpoint:'to-pr'};},
  }};
  const server = createHttpServer(manager,null);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('listener unavailable');
  const client = new Client({name:'companion-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/companion-mcp`)));
  t.after(()=>client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool=>tool.name).sort(),['advance_companion_engineering',
    'dispatch_confirmed_engineering_card','get_companion_continuation_receipt',
    'get_companion_engineering_receipt','get_companion_preparation_receipt',
    'prepare_companion_new_requirement']);
  const input = {schema_version:1,card_store_id:'00000000-0000-4000-8000-000000000001',
    card_id:'00000000-0000-4000-8000-000000000002',revision:1,
    dispatch_id:'00000000-0000-4000-8000-000000000003'};
  const result = await client.callTool({name:'get_companion_engineering_receipt',arguments:input});
  assert.equal((result.structuredContent as {operation_id?: string})?.operation_id,'one');
  const prepared = await client.callTool({name:'prepare_companion_new_requirement',arguments:{
    card_store_id:input.card_store_id,card_id:input.card_id,revision:input.revision}});
  assert.equal((prepared.structuredContent as {preparation_id?: string})?.preparation_id,'new');
  const locator={card_store_id:input.card_store_id,card_id:input.card_id,revision:input.revision};
  const advanced=await client.callTool({name:'advance_companion_engineering',
    arguments:{schema_version:1,...locator}});
  assert.equal(advanced.isError,undefined);
  assert.equal((advanced.structuredContent as {endpoint?: string})?.endpoint,'to-pr');
  assert.equal((await getContinuationReceipt(`http://127.0.0.1:${address.port}/companion-mcp`,locator) as {endpoint?:string}).endpoint,'to-pr');
  assert.deepEqual(calls,['get','prepare','advance','continuation-get']);
});

test('preparation conflict code survives Companion MCP and Desktop client decoding', async t => {
  let failure = 'PREPARATION_PATH_OCCUPIED';
  const manager: any = {closing:false,companionPreparation:{
    prepare:async()=>{throw Error(failure);}, get:async()=>({schema_version:1}),
  }};
  const server = createHttpServer(manager,null);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('listener unavailable');
  const url = `http://127.0.0.1:${address.port}/companion-mcp`;
  const input = {card_store_id:'00000000-0000-4000-8000-000000000001',
    card_id:'00000000-0000-4000-8000-000000000002',revision:1};
  const client = new Client({name:'companion-error-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(()=>client.close());
  const result = await client.callTool({name:'prepare_companion_new_requirement',arguments:input});
  assert.equal(result.isError,true);
  assert.equal((result.structuredContent as {error?: {code?: string}})?.error?.code,
    'PREPARATION_PATH_OCCUPIED');
  await assert.rejects(prepareNewRequirement(url,input),{code:'PREPARATION_PATH_OCCUPIED'});
  failure = 'PREPARATION_SECRET_INTERNAL';
  await assert.rejects(prepareNewRequirement(url,input),error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message,'YCA typed preparation receipt unavailable');
    assert.equal((error as Error & {code?: string}).code,undefined);
    return true;
  });
});

test('continuation conflict code and source survive public MCP and Desktop decoding',async t=>{
  const manager:any={closing:false,companionContinuation:{
    get:()=>{throw new HarnessError('COMPANION_CONTINUATION_AUTHORITY_CONFLICT',
      {source_refs:['card-sqlite']});},advance:()=>({schema_version:1})}};
  const server=createHttpServer(manager,null);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>server.close());
  const address=server.address();
  if (!address || typeof address==='string') throw Error('listener unavailable');
  const input={card_store_id:'00000000-0000-4000-8000-000000000001',
    card_id:'00000000-0000-4000-8000-000000000002',revision:1};
  await assert.rejects(getContinuationReceipt(
    `http://127.0.0.1:${address.port}/companion-mcp`,input),error=>{
    assert.equal((error as Error & {code?:string}).code,'COMPANION_CONTINUATION_AUTHORITY_CONFLICT');
    assert.deepEqual((error as Error & {source_refs?:string[]}).source_refs,['card-sqlite']);
    return true;
  });
});

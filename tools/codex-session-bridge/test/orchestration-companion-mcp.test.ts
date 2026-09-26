import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';

test('companion endpoint advertises only two high-level typed actions', async t => {
  const calls: string[] = [];
  const manager: any = {closing:false,companionDispatch:{
    dispatch:async()=>{calls.push('dispatch');return {schema_version:1,operation_id:'one'};},
    get:()=>{calls.push('get');return {schema_version:1,operation_id:'one'};},
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
  assert.deepEqual(tools.tools.map(tool=>tool.name).sort(),['dispatch_confirmed_engineering_card','get_companion_engineering_receipt']);
  const input = {schema_version:1,card_store_id:'00000000-0000-4000-8000-000000000001',
    card_id:'00000000-0000-4000-8000-000000000002',revision:1,
    dispatch_id:'00000000-0000-4000-8000-000000000003'};
  const result = await client.callTool({name:'get_companion_engineering_receipt',arguments:input});
  assert.equal((result.structuredContent as {operation_id?: string})?.operation_id,'one');
  assert.deepEqual(calls,['get']);
});

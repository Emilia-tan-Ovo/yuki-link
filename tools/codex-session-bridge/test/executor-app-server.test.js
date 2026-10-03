import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnDirect } from '../src/process.js';
import { CodexExecutor } from '../src/executor.js';

const nativeSession = () => ({
  cwd: process.cwd(),
  codex_thread_id: null,
  permissions: {
    version: 1,
    kind: 'native',
    stored: true,
    sandbox_mode: 'danger-full-access',
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    workspace_write: null,
    source: 'fixture',
    resolved_at: new Date().toISOString(),
  },
});

test('native executor uses app-server, preserves approval semantics and declines unavailable interactive approvals', async () => {
  const fixture = String.raw`
    const readline=require('node:readline');
    const rl=readline.createInterface({input:process.stdin});
    const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
    const fail=(m,text)=>send({id:m.id,error:{code:-32000,message:text}});
    rl.on('line', line => {
      const m=JSON.parse(line);
      if(m.method==='initialize') return send({id:m.id,result:{userAgent:'fixture'}});
      if(m.method==='thread/start'){
        if(m.params.approvalPolicy!=='on-request'||m.params.approvalsReviewer!=='user'
          ||m.params.sandbox!=='danger-full-access'||m.params.model!=='gpt-6-astra'
          ||m.params.serviceTier!=='fast') return fail(m,'bad thread params');
        send({id:m.id,result:{thread:{id:'11111111-1111-4111-8111-111111111111'}}});
        return send({method:'thread/started',params:{thread:{id:'11111111-1111-4111-8111-111111111111'}}});
      }
      if(m.method==='turn/start'){
        if(m.params.approvalPolicy!=='on-request'||m.params.approvalsReviewer!=='user'
          ||m.params.effort!=='xhigh'||m.params.model!=='gpt-6-astra'
          ||m.params.serviceTierForTurn!=='fast'||m.params.input?.[0]?.text!=='hello')
          return fail(m,'bad turn params');
        send({id:m.id,result:{turn:{id:'22222222-2222-4222-8222-222222222222',status:'inProgress'}}});
        send({method:'turn/started',params:{turn:{id:'22222222-2222-4222-8222-222222222222'}}});
        return send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{
          threadId:'11111111-1111-4111-8111-111111111111',
          turnId:'22222222-2222-4222-8222-222222222222',itemId:'cmd-1',
          command:'Write-Output blocked'
        }});
      }
      if(m.id==='approval-1'){
        if(m.result?.decision!=='decline') process.exit(23);
        send({method:'item/completed',params:{item:{
          type:'commandExecution',id:'cmd-1',command:'Write-Output blocked',
          commandActions:[],cwd:process.cwd(),status:'declined',
          aggregatedOutput:'',exitCode:null
        }}});
        send({method:'item/completed',params:{item:{
          type:'agentMessage',id:'msg-1',text:'APP_OK',phase:'final_answer'
        }}});
        send({method:'thread/tokenUsage/updated',params:{
          threadId:'11111111-1111-4111-8111-111111111111',
          turnId:'22222222-2222-4222-8222-222222222222',tokenUsage:{total:{
          inputTokens:11,cachedInputTokens:7,cacheWriteInputTokens:0,
          outputTokens:3,reasoningOutputTokens:1
        },last:{inputTokens:11,cachedInputTokens:7,cacheWriteInputTokens:0,
          outputTokens:3,reasoningOutputTokens:1}}}});
        send({method:'turn/completed',params:{turn:{
          id:'22222222-2222-4222-8222-222222222222',status:'completed',error:null
        }}});
      }
    });
    setInterval(()=>{},1000);
  `;
  let seenArgs;
  const executor = new CodexExecutor('fixture-codex', (_command, args, options) => {
    seenArgs = args;
    return spawnDirect(process.execPath, ['-e', fixture], options);
  }, () => ({ executable: 'fixture-codex' }));
  const events = [];
  const stderr = [];
  const done = await new Promise(resolve => executor.start(
    { model: 'gpt-6-astra', reasoning: 'xhigh', service_tier: 'fast' },
    nativeSession(),
    'hello',
    { onEvent: event => events.push(event), onStderr: line => stderr.push(line), onSpawn: () => {}, onDone: resolve },
  ));
  assert.deepEqual(seenArgs, ['app-server', '--stdio']);
  assert.equal(done.code, 0);
  assert.deepEqual(stderr, []);
  assert.ok(events.some(event => event.type === 'thread.started'
    && event.thread_id === '11111111-1111-4111-8111-111111111111'));
  assert.ok(events.some(event => event.type === 'approval.declined'
    && event.method === 'item/commandExecution/requestApproval'));
  const command = events.find(event => event.type === 'item.completed'
    && event.item?.type === 'command_execution');
  assert.equal(command.item.status, 'declined');
  assert.equal(command.item.aggregated_output, '');
  const message = events.find(event => event.type === 'item.completed'
    && event.item?.type === 'agent_message');
  assert.equal(message.item.text, 'APP_OK');
  const completed = events.find(event => event.type === 'turn.completed');
  assert.deepEqual(completed.usage, {
    input_tokens: 11,
    cached_input_tokens: 7,
    cache_write_input_tokens: 0,
    output_tokens: 3,
    reasoning_output_tokens: 1,
  });
});

test('native app-server resume preserves the bound thread id', async () => {
  const fixture = String.raw`
    const readline=require('node:readline');
    const rl=readline.createInterface({input:process.stdin});
    const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
    rl.on('line', line => {
      const m=JSON.parse(line);
      if(m.method==='initialize') return send({id:m.id,result:{}});
      if(m.method==='thread/resume'){
        if(m.params.threadId!=='33333333-3333-4333-8333-333333333333'
          ||m.params.approvalPolicy!=='on-request') process.exit(31);
        send({id:m.id,result:{thread:{id:m.params.threadId}}});
        return send({method:'thread/started',params:{thread:{id:m.params.threadId}}});
      }
      if(m.method==='turn/start'){
        send({id:m.id,result:{turn:{id:'44444444-4444-4444-8444-444444444444',status:'inProgress'}}});
        send({method:'turn/started',params:{turn:{id:'44444444-4444-4444-8444-444444444444'}}});
        send({method:'item/completed',params:{item:{type:'agentMessage',id:'msg-2',text:'RESUME_OK'}}});
        send({method:'turn/completed',params:{turn:{id:'44444444-4444-4444-8444-444444444444',status:'completed'}}});
      }
    });
    setInterval(()=>{},1000);
  `;
  const executor = new CodexExecutor('fixture-codex',
    (_command, _args, options) => spawnDirect(process.execPath, ['-e', fixture], options),
    () => ({ executable: 'fixture-codex' }));
  const session = nativeSession();
  session.codex_thread_id = '33333333-3333-4333-8333-333333333333';
  const events = [];
  const done = await new Promise(resolve => executor.start(
    { model: 'gpt-6-astra', reasoning: 'xhigh', service_tier: 'fast' },
    session, 'resume', {
      onEvent: event => events.push(event), onStderr: () => {}, onSpawn: () => {}, onDone: resolve,
    },
  ));
  assert.equal(done.code, 0);
  const threads = events.filter(event => event.type === 'thread.started');
  assert.equal(threads.length, 1);
  assert.equal(threads[0].thread_id, session.codex_thread_id);
  assert.equal(events.find(event => event.item?.type === 'agent_message').item.text, 'RESUME_OK');
});

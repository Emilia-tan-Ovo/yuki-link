import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineeringCardStore } from '../backend/engineering-card-store.mjs';
import { EngineeringCoordinator } from '../backend/engineering-coordinator.mjs';

test('coordinator keeps DSH turn and typed engineering facts separate and never repeats a turn', async t => {
  const dir = mkdtempSync(join(tmpdir(),'yuki-coordinator-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store = new EngineeringCardStore(dir), repo='Emilia-tan-Ovo/yuki-link';
  const card = store.create({original:'实现 #130',projectKey:'yuki-link',repository:repo,
    ticket:{id:1300,repository:repo,number:130,marker:'COMPANION-005',url:`https://github.com/${repo}/issues/130`,scope:{digest:'a'.repeat(64)}},
    resolution:{status:'verified_existing'},desiredPhase:'implementation',endpoint:'to-pr',extraAuthorization:{merge:false,deploy:false}});
  const confirmed = store.confirm(card.cardId,1,'desktop-user-action').card;
  let turns=0, reads=0;
  const coordinator = new EngineeringCoordinator({store,config:{ycaUrl:'http://127.0.0.1:7391/companion-mcp'},
    runTurn:async()=>{turns++;return {state:'turn-completed',exit_code:0,summary:'我完成了'};},
    receipt:async()=>{reads++;return {schema_version:1,operation_id:'operation-1',operation_state:'started',
      run_id:'run-1',run:{status:'completed',final_response:'已完成实际修改'},workflow:{current:{phase:'implementation'}},
      acceptance:{status:'pending'},pr_delivery:{state:'unknown'},reconciliation:false};}});
  const first = await coordinator.dispatch(confirmed);
  assert.equal(first.dsh_turn.state,'turn-completed');
  assert.equal(first.status.engineering_operation.state,'started');
  assert.equal(first.status.run.status,'completed');
  assert.equal(first.status.run.final_response,'已完成实际修改');
  assert.equal(first.status.acceptance.status,'pending');
  assert.equal(first.status.pr_delivery.state,'unknown');
  assert.equal((await coordinator.dispatch(confirmed)).state,'already-started');
  assert.equal(turns,1); assert.equal(reads,2);
  store.close();
});

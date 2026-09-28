import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { Harness } from '../../src/harness/harness.ts';
import { subjectIdentity } from '../../src/harness/workflow.ts';
import { FileExecutionAuthority } from '../../src/orchestration/execution-authority.ts';
import { FileWorkflowAgentAuthoritySource, WorkflowAgentLauncher, digestWorkflowAgentPolicy }
  from '../../src/orchestration/workflow-agent-launcher.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Real journal, WorkflowSource, ConversationHistory, authority files and launcher;
// only the external model transport is deterministic and never starts a model.
export function reviewFixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'managed-review-'));
  const repo = path.join(root, 'repo'), runtime = path.join(root, 'runtime');
  mkdirSync(repo); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repo, '.gitignore'), '.local/\n', 'utf8');
  writeFileSync(path.join(repo, 'subject.txt'), 'baseline\n', 'utf8');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline');
  const head = git(repo, 'rev-parse', 'HEAD');
  mkdirSync(path.join(repo, '.local'), { recursive: true });
  const sessions = new Map<string, any>(), runs = new Map<string, any>(), requests = new Map<string, any>();
  let sequence = 0;
  const source: any = { session: (id: string) => sessions.get(id),
    runs: (id: string) => [...runs.values()].filter(value => value.session_id === id),
    events: (run: any) => [{ type: 'codex', data: { type: 'thread.started', thread_id: sessions.get(run.session_id)?.codex_thread_id } }],
    attribution: () => ({ state: 'unknown' }), lookupRequest: (id: string) => requests.get(id),
    activeRuns: () => [...runs.values()].filter(value => value.status === 'running') };
  let harness = new Harness(runtime, source, undefined, { git: () => 'git' });
  const registration = harness.register({ project_key: 'fixture', project_name: 'Fixture', ticket_key: 'delivery',
    title: 'Managed reviews', reference: 'issue:fixture', expected_worktree: repo, fixed_point: head });
  const identity = () => {
    const value = harness.changes.facts.currentIdentity(harness.tickets.get(registration.ticket_id)!.comparison_baseline!);
    return { scheme: value.scheme, version: value.version, scope: value.scope, completeness: value.completeness, digest: value.digest };
  };
  const snapshot: any = { phase: 'implementation', actor: { name: 'fixture', method: 'deterministic' },
    checkpoint: { artifact_id: 'checkpoint', ticket_key: 'delivery', worktree: repo, branch: 'main', fixed_point: head,
      head, phase: 'implementation', schema_version: 1 },
    subject: { subject_id: 'subject', fixed_point: head, head, scope: ['subject.txt'], staged: [], unstaged: [], untracked: [],
      ticket_ref: 'issue:fixture', spec_ref: 'spec.md', standards: ['AGENTS.md'], tests: ['fixture'] },
    artifacts: [], reviews: [], findings: [], runtime_refs: [],
    acceptance: { acceptance_id: null, status: 'not-recorded', actor: { name: 'fixture', method: 'deterministic' },
      subject_ref: null, criteria: [], evidence: [], evidence_refs: [], execution_refs: [], applicability: 'not-applicable', reason: null },
    closeout: { status: 'pending', artifact_refs: [], evidence: [], applicability: 'not-applicable', reason: null } };
  const artifact = (id: string, role: string, text: string) => {
    const location = path.join(repo, '.local', id + '.md'); writeFileSync(location, text, 'utf8');
    const value = { artifact_id: id, role, kind: 'file', location, revision: hash(text), source_schema: 'fixture-v1',
      source: 'deterministic-fixture', observed_at: null, integrity: 'observed' };
    const index = snapshot.artifacts.findIndex((entry: any) => entry.artifact_id === id);
    if (index < 0) snapshot.artifacts.push(value); else snapshot.artifacts[index] = value;
    return value;
  };
  const record = () => {
    snapshot.checkpoint.phase = snapshot.phase;
    artifact('checkpoint', 'checkpoint', `---\nschema_version: 1\nticket: "delivery"\nphase: ${snapshot.phase}\nworktree: "${repo.replaceAll('\\', '/')}"\nbranch: "main"\nfixed_point: "${head}"\nhead: "${snapshot.subject.head}"\n---\n`);
    const current = harness.workflowHistory.current.get(registration.ticket_id);
    const receipt = harness.recordWorkflow({ schema_version: 1, ticket_id: registration.ticket_id,
      request_id: 'snapshot-' + (++sequence), expected_revision: current?.workflow_revision ?? null, snapshot });
    assert.equal(receipt.applicability.state, 'verified', JSON.stringify(receipt.applicability));
    return receipt;
  };
  const findingRef = (id: string) => ({ origin_review_id: 'primary', finding_id: id });
  const review = (id: string, ids: string[], mode = 'focused') => ({ review_id: id,
    original_review_id: mode === 'focused' ? 'primary' : null, mode, status: 'pending', subject_ref: 'subject',
    subject_identity: subjectIdentity(snapshot.subject), artifact_refs: [],
    standards: { status: 'pending', evidence: [], reason: null }, spec: { status: 'pending', evidence: [], reason: null },
    finding_refs: ids.map(findingRef), isolated: true, applicability: 'verified', reason: null, execution_refs: [] });
  snapshot.reviews.push(review('primary', ['one', 'two'], 'full'));
  snapshot.findings = ['one', 'two'].map(id => ({ ...findingRef(id), status: 'open', severity: 'P2', summary: id,
    subject_ref: 'subject', subject_identity: subjectIdentity(snapshot.subject), verification_review_id: null,
    artifact_refs: [], evidence: [], applicability: 'verified', reason: null }));
  record();
  const authorityPath = path.join(root, 'launch-authority.json');
  writeFileSync(authorityPath, JSON.stringify({ schema_version: 1, policies: [], authorizations: [] }), 'utf8');
  const authority = new FileWorkflowAgentAuthoritySource(authorityPath, { forbiddenRoots: [repo] });
  const transport = async (input: any, guard: any) => {
    const session_id = input.session_id ?? randomUUID(), run_id = randomUUID(), fingerprint = hash(input.request_id);
    guard({ request_id: input.request_id, fingerprint, cwd: repo, ...(input.session_id ? { session_id } : {}),
      config: { model: input.model, reasoning: input.reasoning },
      permissions: { sandbox_mode: 'danger-full-access', approval_policy: 'on-request' },
      launch: { prompt_sha256: hash(input.prompt), prompt_utf8_bytes: Buffer.byteLength(input.prompt),
        sender: input.sender, model: input.model, reasoning: input.reasoning, timeout_ms: null, permission_selection: null } });
    if (!sessions.has(session_id)) sessions.set(session_id, { id: session_id, cwd: repo, codex_thread_id: randomUUID() });
    runs.set(run_id, { id: run_id, session_id, status: 'running', created_at: new Date(1700000000000 + sequence++).toISOString() });
    requests.set(input.request_id, { request_id: input.request_id, fingerprint, session_id, run_id, status: 'running' });
  };
  const manager = { get harness() { return harness; }, workflowAgentAuthority: authority,
    startGuarded: transport, sendGuarded: transport };
  const start = async (action: 'finding-fix' | 'focused-review', ids: string[], item?: any, reviewId?: string) => {
    snapshot.phase = action === 'finding-fix' ? 'implementation' : 'review'; record();
    const policy = { schema_version: 1, policy_id: action, revision: 1, project_key: 'fixture', action,
      workflow_phase: snapshot.phase, model: 'gpt-6-sol', reasoning: 'medium', permission_selection: 'owner-native-default',
      preflight: { require_recording: true, model_line: 'single', required_paths: [], required_executables: [], dependency_packages: [] } };
    const batch = ids.map(id => ({ ...findingRef(id), report_ref: '.local/checkpoint.md', fix_baseline: head }));
    const findings = batch.length === 1 ? { finding: batch[0] } : { finding_batch: batch };
    const authorization = { schema_version: 1, authorization_id: action, ticket_key: 'delivery', action,
      authorization_ref: 'owner:fixture', subject_ref: 'subject', subject_identity: subjectIdentity(snapshot.subject),
      authority_refs: ['owner:fixture'], ...findings, ...(reviewId ? { review_id: reviewId } : {}) };
    writeFileSync(authorityPath, JSON.stringify({ schema_version: 1, policies: [policy], authorizations: [authorization] }), 'utf8');
    const launcher = new WorkflowAgentLauncher({ manager, harness, workflowAuthority: authority,
      environment: { observe: () => ({ required_paths: [], required_executables: [] }) } as any,
      context: () => ({ integrity: { state: 'complete' }, attention: { unknown_side_effects: [] }, retrieval: { references: [] } }) });
    return launcher.start({ schema_version: 1, ticket_id: registration.ticket_id, request_id: 'launch-' + (++sequence),
      action, authorization_ref: 'owner:fixture', ...findings, ...(reviewId ? { review_id: reviewId } : {}),
      ...(item ? { work_item: { work_item_id: item.work_item_id, revision: item.revision } } : {}),
      expected: { workflow_revision: harness.workflowHistory.current.get(registration.ticket_id)!.workflow_revision,
        subject_ref: 'subject', subject_identity: subjectIdentity(snapshot.subject), content_identity: identity(),
        policy: { policy_id: action, revision: 1, digest: digestWorkflowAgentPolicy(policy) } } });
  };
  const finish = () => { for (const run of runs.values()) run.status = 'completed'; for (const request of requests.values()) request.status = 'completed'; };
  const transition = (item: any, action: string, extras = {}) => {
    const evidence = snapshot.artifacts.find((value: any) => value.artifact_id === 'checkpoint');
    const decision = { decision_ref: 'owner:decision', work_item_id: item.work_item_id, expected_revision: item.revision,
      workflow_revision: harness.workflowHistory.current.get(registration.ticket_id)!.workflow_revision,
      subject_ref: 'subject', content_version: identity().digest, action, evidence_refs: ['.local/checkpoint.md'], ...extras };
    const filename = path.join(root, 'decision-authority.json');
    writeFileSync(filename, JSON.stringify({ schema_version: 1, raw_access: [], decisions: [{ ...decision,
      evidence: [{ path: '.local/checkpoint.md', sha256: hash(readFileSync(evidence.location)) }] }] }), 'utf8');
    const trusted = new FileExecutionAuthority(filename, { forbiddenRoots: [repo] }).decision(decision.decision_ref, repo);
    return harness.executionOperations.transitionWorkItem(trusted);
  };
  const report = (receipt: any, id: string, status: string, verifiedIds: string[] = []) => {
    finish();
    const value = snapshot.reviews.find((entry: any) => entry.review_id === id);
    value.status = status; value.standards.status = value.spec.status = status;
    value.artifact_refs = [artifact(id, 'review-report', `${id}: ${status}\n`).artifact_id];
    const ref = 'run-' + receipt.runtime.run_id;
    snapshot.runtime_refs.push({ runtime_ref_id: ref, kind: 'codex-run', session_id: receipt.runtime.session_id,
      run_id: receipt.runtime.run_id, task_id: null, call_id: null, expected_state: 'completed', source: 'runtime-fixture' });
    value.execution_refs = [ref];
    for (const finding of snapshot.findings) if (verifiedIds.includes(finding.finding_id)) {
      finding.status = 'verified'; finding.verification_review_id = id;
    }
    record(); return value;
  };
  const pending = (id: string, ids: string[]) => { snapshot.reviews.push(review(id, ids)); record(); };
  const restart = () => { harness.close(); harness = new Harness(runtime, source, undefined, { git: () => 'git' }); };
  t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
  return { start, finish, transition, report, pending, record, snapshot, sessions, runs, requests, source, restart, repo,
    identity, get harness() { return harness; }, current: (item: any) => harness.executionOperations.workItems.get(item.work_item_id) };
}

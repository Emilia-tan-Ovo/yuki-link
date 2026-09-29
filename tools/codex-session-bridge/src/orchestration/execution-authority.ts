import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HarnessError } from '../harness/model.ts';
import { workItemDecisionSchema } from '../harness/work-item-model.ts';
import { workDigest } from './work-items.ts';

const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const rawGrantSchema = z.object({ authorization_ref: text, category: z.enum(['compatibility', 'diagnostic', 'admin']),
  action: z.enum(['start', 'send']), payload_digest: hash, reason: text }).strict();
const authoritySchema = z.object({ schema_version: z.literal(1),
  decisions: z.array(workItemDecisionSchema.extend({ evidence: z.array(z.object({ path: text, sha256: hash }).strict()).min(1) }).strict()).max(1024),
  raw_access: z.array(rawGrantSchema).max(1024) }).strict();
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const bytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class FileExecutionAuthority {
  private readonly filename: string;
  private readonly canonical: string;
  private readonly forbiddenRoots: string[];
  constructor(filename: string, { forbiddenRoots = [] }: { forbiddenRoots?: string[] } = {}) {
    if (!path.isAbsolute(filename)) throw new HarnessError('EXECUTION_AUTHORITY_UNTRUSTED');
    this.filename = filename;
    this.canonical = realpathSync(filename);
    this.forbiddenRoots = forbiddenRoots.map(root => realpathSync(root));
    this.read();
  }
  private read() {
    if (realpathSync(this.filename) !== this.canonical || this.forbiddenRoots.some(root => inside(root, this.canonical)))
      throw new HarnessError('EXECUTION_AUTHORITY_UNTRUSTED');
    const bytes = readFileSync(this.canonical);
    return { document: authoritySchema.parse(JSON.parse(bytes.toString('utf8'))), digest: bytesHash(bytes) };
  }
  raw(action: 'start' | 'send', reference: string | undefined, payload: unknown) {
    const snapshot = this.read();
    const matches = snapshot.document.raw_access.filter(grant => grant.authorization_ref === reference
      && grant.action === action && grant.payload_digest === workDigest(payload));
    if (matches.length !== 1) throw new HarnessError('RAW_EXECUTION_NOT_AUTHORIZED');
    return { ...matches[0], authority_digest: snapshot.digest };
  }
  decision(reference: string, worktree: string) {
    const snapshot = this.read();
    if (inside(realpathSync(worktree), this.canonical)) throw new HarnessError('EXECUTION_AUTHORITY_UNTRUSTED');
    const matches = snapshot.document.decisions.filter(value => value.decision_ref === reference);
    if (matches.length !== 1) throw new HarnessError('WORK_ITEM_TRANSITION_NOT_AUTHORIZED');
    const { evidence, ...decision } = matches[0];
    for (const file of evidence) {
      const filename = realpathSync(path.resolve(worktree, file.path));
      if (!inside(realpathSync(worktree), filename) || bytesHash(readFileSync(filename)) !== file.sha256)
        throw new HarnessError('WORK_ITEM_EVIDENCE_CONFLICT');
    }
    if (decision.evidence_refs.some(ref => !evidence.some(file => file.path === ref)))
      throw new HarnessError('WORK_ITEM_EVIDENCE_CONFLICT');
    return decision;
  }
}

export async function executeRaw(manager: any, action: 'start' | 'send', raw: any) {
  const { authorization_ref, ...input } = raw;
  if (!authorization_ref || !manager.executionAuthority || !manager.harness)
    throw new HarnessError('RAW_EXECUTION_NOT_AUTHORIZED');
  const source = manager.executionAuthority as FileExecutionAuthority;
  const grant = source.raw(action, authorization_ref, input);
  const operations = manager.harness.executionOperations;
  operations.reserveRaw(input, grant);
  try {
    return await manager[action === 'start' ? 'startGuarded' : 'sendGuarded'](input, () => {
      const current = source.raw(action, authorization_ref, input);
      if (workDigest(current) !== workDigest(grant)) throw new HarnessError('RAW_EXECUTION_AUTHORITY_CONFLICT');
      operations.guardRaw(input, grant);
    });
  } catch (error) { operations.rawFailure(input.request_id); throw error; }
}

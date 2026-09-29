import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const sha = /^[0-9a-f]{40}$/u;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const branch = /^refs\/heads\/[A-Za-z0-9._/-]+$/u;
const error = code => Object.assign(new Error(code),{code});

// The transport is deliberately narrow. Every list is complete or throws; a search miss
// is never evidence that a timed-out create did not reach GitHub.
export class GhCompanionPrTransport {
  api(args) {
    return JSON.parse(execFileSync('gh',['api',...args],{encoding:'utf8',windowsHide:true,
      shell:false,timeout:20_000,maxBuffer:4*1024*1024}));
  }
  async actor() { return this.api(['user']).login; }
  async ref(repo,ref) { return this.api([`repos/${repo}/git/ref/${ref.slice(5)}`]).object?.sha; }
  async read(repo,number) { return this.api([`repos/${repo}/pulls/${number}`]); }
  async list(repo,head,base) {
    const output=[];
    for (let page=1;page<=20;page++) {
      const values=this.api(['-X','GET',`repos/${repo}/pulls`,'-f','state=all',
        '-f','per_page=100','-f',`page=${page}`]);
      if (!Array.isArray(values)) throw error('COMPANION_PR_QUERY_INCOMPLETE');
      output.push(...values.filter(value => value.head?.ref === head && value.base?.ref === base));
      if (values.length<100) return output;
    }
    throw error('COMPANION_PR_QUERY_INCOMPLETE');
  }
  async create(repo,payload) {
    return this.api(['-X','POST',`repos/${repo}/pulls`,'-f',`title=${payload.title}`,
      '-f',`body=${payload.body}`,'-f',`head=${payload.head_ref.slice(11)}`,
      '-f',`base=${payload.base_ref.slice(11)}`,'-F','draft=true']);
  }
}

export class CompanionDeliveryAdapter {
  constructor({store,transport=new GhCompanionPrTransport(),observeAuthority}) {
    this.store=store; this.transport=transport; this.observeAuthority=observeAuthority;
  }
  validate(value) {
    if (!value || !repository.test(value.repository) || !repository.test(value.head_repo)
      || !repository.test(value.base_repo) || !branch.test(value.head_ref)
      || !branch.test(value.base_ref) || !sha.test(value.head_oid) || !sha.test(value.base_oid)
      || !value.ticket_ref || !value.subject_identity || !value.acceptance_ref
      || typeof value.title !== 'string' || !value.title.trim() || value.title.length>240
      || typeof value.body !== 'string' || value.body.length>30000
      || !value.body.includes(value.ticket_ref) || value.body.includes('yuki-companion-delivery:')
      || value.repository !== value.base_repo) throw error('COMPANION_PR_INTENT_INVALID');
  }
  marker(cardId,revision) { return `<!-- yuki-companion-delivery:${cardId}:${revision} -->`; }
  async identity(intent) {
    const [actor,head,base]=await Promise.all([
      this.transport.actor(),this.transport.ref(intent.head_repo,intent.head_ref),
      this.transport.ref(intent.base_repo,intent.base_ref)]);
    if (!actor || head!==intent.head_oid || base!==intent.base_oid)
      throw error('COMPANION_PR_SUBJECT_CHANGED');
    return actor;
  }
  matches(pr,intent) {
    return pr?.base?.repo?.full_name === intent.base_repo && pr.base.ref === intent.base_ref.slice(11)
      && pr?.head?.repo?.full_name === intent.head_repo && pr.head.ref === intent.head_ref.slice(11)
      && pr.head.sha === intent.head_oid && pr.user?.login === intent.actor
      && pr.title === intent.title && pr.body === intent.body && pr.draft === true
      && Number.isSafeInteger(pr.number) && Number.isSafeInteger(pr.id);
  }
  async reconcile(locator,{persist=true}={}) {
    const action=this.store.continuationAction(locator.card_id,locator.revision,'pr-delivery');
    if (!action) return {state:'not-started'};
    const intent=action.intent;
    if (action.attempt_state==='verified') {
      try {
        const pr=await this.transport.read(intent.repository,action.receipt.number);
        if (!this.matches(pr,intent) || pr.id!==action.receipt.id)
          return {state:'unknown',reason:'COMPANION_PR_RECEIPT_DRIFT'};
        return {state:pr.state==='open' ? 'delivered':'observed-closed',
          reference:pr.html_url,id:pr.id,number:pr.number};
      } catch { return {state:'unknown',reason:'COMPANION_PR_READ_UNKNOWN'}; }
    }
    if (action.attempt_state==='reserved') return {state:'reserved'};
    if (action.attempt_state==='definitely-not-applied') return {state:'blocked',reason:'COMPANION_PR_NOT_ATTEMPTED'};
    try {
      const candidates=action.receipt?.number
        ? [await this.transport.read(intent.repository,action.receipt.number)]
        : await this.transport.list(intent.repository,intent.head_ref.slice(11),intent.base_ref.slice(11));
      const matched=candidates.filter(value => this.matches(value,intent));
      if (matched.length!==1) return {state:'unknown',reason:matched.length>1
        ? 'COMPANION_PR_MULTIPLE_CANDIDATES':'COMPANION_PR_NO_UNIQUE_CANDIDATE'};
      const reread=await this.transport.read(intent.repository,matched[0].number);
      if (!this.matches(reread,intent) || reread.id!==matched[0].id)
        return {state:'unknown',reason:'COMPANION_PR_IDENTITY_CONFLICT'};
      if (persist) {
        const saved=this.store.updateContinuationAction(locator.card_id,locator.revision,
          'pr-delivery',action.attempt_state,'verified',{id:reread.id,number:reread.number,url:reread.html_url});
        if (saved.conflict) return {state:'unknown',reason:'COMPANION_PR_RECEIPT_CONFLICT'};
      } else return {state:'unknown',reason:'COMPANION_PR_RECEIPT_NOT_RECORDED',
        reference:reread.html_url,id:reread.id,number:reread.number};
      return {state:reread.state==='open' ? 'delivered':'observed-closed',
        reference:reread.html_url,id:reread.id,number:reread.number};
    } catch { return {state:'unknown',reason:'COMPANION_PR_QUERY_INCOMPLETE'}; }
  }
  async deliver(locator,payload) {
    this.validate(payload);
    const existing=this.store.continuationAction(locator.card_id,locator.revision,'pr-delivery');
    const marker=this.marker(locator.card_id,locator.revision);
    if (existing) {
      const expected={...payload,body:`${payload.body}\n\n${marker}`,
        marker,body_digest:hash(`${payload.body}\n\n${marker}`),actor:existing.intent.actor};
      if (JSON.stringify(expected)!==JSON.stringify(existing.intent))
        throw error('COMPANION_PR_INTENT_CONFLICT');
      return existing.attempt_state==='reserved' ? this.attemptReserved(locator,existing.intent)
        : this.reconcile(locator);
    }
    const frozen={...payload,body:`${payload.body}\n\n${marker}`,marker,
      body_digest:hash(`${payload.body}\n\n${marker}`),actor:await this.transport.actor()};
    await this.observeAuthority(locator,frozen);
    if (await this.identity(frozen)!==frozen.actor) throw error('COMPANION_PR_ACTOR_CHANGED');
    const claimed=this.store.claimContinuationAction(locator.card_id,locator.revision,'pr-delivery',frozen);
    if (claimed.conflict) throw error('COMPANION_PR_INTENT_CONFLICT');
    if (claimed.deduplicated) return this.reconcile(locator);
    return this.attemptReserved(locator,frozen);
  }
  async attemptReserved(locator,frozen) {
    await this.observeAuthority(locator,frozen);
    if (await this.identity(frozen)!==frozen.actor) throw error('COMPANION_PR_SUBJECT_CHANGED');
    // A conflicting PR on the exact head/base blocks creation even if its title matches.
    let before;
    try { before=await this.transport.list(frozen.repository,frozen.head_ref.slice(11),frozen.base_ref.slice(11)); }
    catch { return {state:'unknown',reason:'COMPANION_PR_QUERY_INCOMPLETE'}; }
    if (before.length) return {state:'blocked',reason:'COMPANION_PR_EXISTING_CONFLICT'};
    await this.observeAuthority(locator,frozen);
    if (await this.identity(frozen)!==frozen.actor) throw error('COMPANION_PR_SUBJECT_CHANGED');
    this.store.assertWorkAllowed?.(locator.card_id,locator.revision);
    const attempt=this.store.updateContinuationAction(locator.card_id,locator.revision,
      'pr-delivery','reserved','attempted');
    if (attempt.conflict) return this.reconcile(locator);
    try {
      this.store.assertWorkAllowed?.(locator.card_id,locator.revision);
      const response=await this.transport.create(frozen.repository,frozen);
      if (Number.isSafeInteger(response?.number)) this.store.updateContinuationAction(
        locator.card_id,locator.revision,'pr-delivery','attempted','unknown',
        {id:response.id,number:response.number});
    } catch { /* A timeout may follow a successful remote create. */ }
    return this.reconcile(locator);
  }
}

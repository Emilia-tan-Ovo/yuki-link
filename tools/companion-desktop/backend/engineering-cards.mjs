const DEFAULT_PROJECTS = Object.freeze([{ key: 'yuki-link', aliases: ['yuki-link', 'Yuki Link'], repository: 'Emilia-tan-Ovo/yuki-link' }]);
const observedAt = () => new Date().toISOString();
const short = value => typeof value === 'string' && /^0?\d{3}$/u.test(value.trim());
const number = value => { const match = typeof value === 'string' && value.trim().match(/^#(\d+)$/u); return match ? Number(match[1]) : null; };
const projectFor = (value, projects) => projects.find(item => item.key.toLowerCase() === value?.toLowerCase() || item.aliases?.some(alias => alias.toLowerCase() === value?.toLowerCase()));
const validIssue = (entry, repository) => entry && entry.repository === repository && Number.isSafeInteger(entry.number) && entry.number > 0 && typeof entry.title === 'string' && entry.title.trim() && entry.url === `https://github.com/${repository}/issues/${entry.number}`;
const routeMatches = (entry, token, routeKey) => [entry?.routeKey, entry?.title].some(value => typeof value === 'string' && new RegExp(`(?:^|[^0-9])${token}(?:$|[^0-9])`, 'iu').test(value) && (!routeKey || value.toLowerCase().includes(routeKey.toLowerCase())));
const result = (status, reason, rest = {}) => ({ ticket: null, candidates: [], ...rest, resolution: { status, reason, observedAt: observedAt(), source: status === 'verified_existing' ? 'github' : status === 'explicit_new_requirement' ? 'owner-explicit' : null } });

export async function resolveTarget(candidate, { projects = DEFAULT_PROJECTS, issueSource, focus, recentCards = [], candidateSources = [] } = {}) {
  const project = projectFor(candidate.project || focus?.projectKey, projects);
  if (candidate.noTicket === true) return project ? result('explicit_new_requirement','Owner 明确表示尚无 Ticket。',{ projectKey: project.key, repository: project.repository }) : result('ambiguous','请明确新需求所属项目。');
  const token = candidate.ticket?.trim();
  if (!token) return result('ambiguous','请明确 Ticket 或说明这是尚无 Ticket 的新需求。',{ projectKey: project?.key ?? null, repository: project?.repository ?? null });
  if (number(token) !== null) {
    if (!project) return result('ambiguous','请明确 Ticket 所属项目。');
    if (!issueSource?.lookup) return result('source_unavailable','GitHub Issue 只读来源未配置。',{ projectKey: project.key, repository: project.repository });
    try {
      const entry = await issueSource.lookup(project.repository,number(token));
      if (!entry || !validIssue(entry,project.repository)) return result('verification_failed','GitHub Issue 不存在或 canonical 引用不匹配。',{ projectKey: project.key, repository: project.repository });
      return result('verified_existing','已读取 GitHub Issue。',{ projectKey: project.key, repository: project.repository, ticket: entry });
    } catch { return result('source_unavailable','GitHub Issue 当前不可读取。',{ projectKey: project.key, repository: project.repository }); }
  }
  if (!short(token)) return result('ambiguous','Ticket 标识不完整，请填写 #编号或明确路线。',{ projectKey: project?.key ?? null, repository: project?.repository ?? null });
  const focusedTicket = focus?.ticket;
  if (project && validIssue(focusedTicket,project.repository) && routeMatches(focusedTicket,token,candidate.routeKey)) {
    if (!issueSource?.lookup) return result('source_unavailable','当前焦点尚未经过 GitHub 重新核验。',{ projectKey: project.key, repository: project.repository });
    try {
      const verified = await issueSource.lookup(project.repository,focusedTicket.number);
      if (!validIssue(verified,project.repository) || verified.url !== focusedTicket.url || !routeMatches(verified,token,candidate.routeKey)) return result('verification_failed','当前焦点与 GitHub Issue 不匹配。',{ projectKey: project.key, repository: project.repository });
      return result('verified_existing','当前工程焦点已由 GitHub Issue 重新核验。',{ projectKey: project.key, repository: project.repository, ticket: verified });
    } catch { return result('source_unavailable','当前焦点的 GitHub Issue 不可读取。',{ projectKey: project.key, repository: project.repository }); }
  }
  if (!issueSource?.search) return result('source_unavailable','简称候选的 GitHub 搜索来源未配置，无法核对唯一性。',{ projectKey: project?.key ?? null, repository: project?.repository ?? null });
  const scoped = project ? [project] : projects;
  const matches = [];
  let candidateSourceFailed = false;
  for (const item of scoped) {
    for (const card of recentCards) if (card.state !== 'revoked' && card.content?.resolution?.status === 'verified_existing' && card.content.repository === item.repository && routeMatches(card.content.ticket,token,candidate.routeKey)) matches.push({ ...card.content.ticket, reason: '近期卡片' });
    for (const source of candidateSources) {
      try { for (const entry of await source.search?.(item.repository,token) ?? []) if (routeMatches(entry,token,candidate.routeKey)) matches.push({ ...entry, reason: source.reason ?? '只读关联' }); } catch { candidateSourceFailed = true; }
    }
    if (issueSource?.search) {
      try { for (const entry of await issueSource.search(item.repository,token) ?? []) if (routeMatches(entry,token,candidate.routeKey)) matches.push({ ...entry, reason: 'GitHub 候选' }); }
      catch { return result('source_unavailable','GitHub 候选当前不可读取。'); }
    }
  }
  const candidates = [...new Map(matches.filter(entry => scoped.some(item => validIssue(entry,item.repository))).map(entry => [entry.url,entry])).values()];
  if (candidates.length !== 1 || candidateSourceFailed) return result('ambiguous',candidates.length > 1 ? '存在多个合理候选，请选择路线和 Ticket。' : candidateSourceFailed ? '候选来源暂不可读取，请明确 Ticket。' : '未找到唯一候选，请填写完整 Ticket。',{ candidates });
  const selected = candidates[0];
  if (!issueSource?.lookup) return result('source_unavailable','唯一候选尚未经过 GitHub 核验。',{ candidates, projectKey: project?.key ?? null });
  try {
    const verified = await issueSource.lookup(selected.repository,selected.number);
    if (!validIssue(verified,selected.repository) || verified.url !== selected.url) return result('verification_failed','候选与 GitHub Issue 不匹配。',{ candidates });
    const chosenProject = projectFor(scoped.find(item => item.repository === verified.repository)?.key,projects);
    return result('verified_existing','简称已由 GitHub Issue 核验。',{ projectKey: chosenProject.key, repository: verified.repository, ticket: verified, candidates });
  } catch { return result('source_unavailable','唯一候选的 GitHub Issue 当前不可读取。',{ candidates }); }
}

export function localCandidate(text) {
  const project = /yuki.link/iu.test(text) ? 'yuki-link' : null;
  const explicit = text.replace(/\bPR\s*#\d+/giu,'').match(/(?:#|issues\/)(\d{1,7})/iu);
  const shorthand = text.match(/(?:继续|处理|完成|做|票|ticket)\s*([a-z]+-)?(\d{3})\b/iu);
  const noTicket = /(?:新需求|还没\s*Ticket|没有\s*Ticket|尚无\s*Ticket)/iu.test(text);
  return { project, ticket: explicit ? `#${explicit[1]}` : shorthand ? shorthand[2] : null, routeKey: shorthand?.[1] ? `${shorthand[1]}${shorthand[2]}` : null, noTicket, summary: text.slice(0,240), desiredPhase: /设计|design/iu.test(text) ? 'ticket-design' : 'implementation', endpoint: /(?:到\s*PR|做到\s*PR|给我\s*PR)/iu.test(text) ? 'to-pr' : /(?:只做设计|仅设计|design.only)/iu.test(text) ? 'design-only' : null, extraAuthorization: explicitAuthorization(text) };
}

function explicitAuthorization(text) {
  const merge = /(?:合并|merge)/iu.test(text), deploy = /(?:部署|deploy)/iu.test(text);
  const mergeTarget = text.match(/(?:合并|merge)\s*(?:到|至)?\s*(PR\s*#\d+)/iu)?.[1] ?? '';
  const deployTarget = text.match(/(?:部署|deploy)\s*(?:到|至)\s*([\w.-]+)/iu)?.[1] ?? '';
  return { merge: merge ? { requested: true, target: mergeTarget, status: mergeTarget ? 'explicit' : 'needs_clarification' } : false, deploy: deploy ? { requested: true, target: deployTarget, status: deployTarget ? 'explicit' : 'needs_clarification' } : false };
}

export async function modelCandidate(provider, text) {
  if (!provider) return localCandidate(text);
  try {
    const response = await provider({ messages: [{ role: 'system', content: '从用户工程要求中只抽取候选，输出单个 JSON 对象：project,ticket,noTicket,summary,desiredPhase,endpoint。ticket 仅提取原话中的 #编号或三位简称；endpoint 仅 design-only/to-pr/null。不要判定事实或添加原话未提及的授权。' }, { role: 'user', content: text }], thinking: { enabled: false } });
    const value = JSON.parse(response.content.replace(/^```(?:json)?\s*|\s*```$/gu,''));
    const lexical = localCandidate(text);
    const proposedProject = typeof value.project === 'string' ? value.project : null;
    const proposedTicket = typeof value.ticket === 'string' ? value.ticket : null;
    return { project: proposedProject && text.toLowerCase().includes(proposedProject.toLowerCase()) ? proposedProject : lexical.project, ticket: proposedTicket && lexical.ticket === proposedTicket ? proposedTicket : lexical.ticket, routeKey: lexical.routeKey, noTicket: lexical.noTicket, summary: typeof value.summary === 'string' ? value.summary.slice(0,500) : text.slice(0,240), desiredPhase: ['ticket-design','implementation','review','acceptance'].includes(value.desiredPhase) ? value.desiredPhase : lexical.desiredPhase, endpoint: lexical.endpoint, extraAuthorization: lexical.extraAuthorization };
  } catch { return localCandidate(text); }
}

export class EngineeringCards {
  constructor({ store, projects = DEFAULT_PROJECTS, extract = localCandidate, issueSource, workflowSource, candidateSources = [] }) { Object.assign(this,{ store, projects, extract, issueSource, workflowSource, candidateSources }); }
  async content(original, candidate, focus) {
    const target = await resolveTarget(candidate,{ projects: this.projects, issueSource: this.issueSource, focus, recentCards: this.store.list(), candidateSources: this.candidateSources });
    return { original, summary: candidate.summary || original.slice(0,240), projectKey: target.projectKey ?? null, repository: target.repository ?? null, ticket: target.ticket, candidates: target.candidates, resolution: target.resolution, desiredPhase: candidate.desiredPhase ?? null, endpoint: candidate.endpoint ?? null, extraAuthorization: candidate.extraAuthorization ?? explicitAuthorization(original) };
  }
  async create(original, focus) { const candidate = await this.extract(original); const content = await this.content(original,candidate,focus ?? null); const card = this.store.create(content); return this.refresh(card.cardId); }
  async edit(cardId, expectedRevision, fields) { const current = this.store.get(cardId); if (!current) throw Error('工程卡片不存在。'); if (current.revision !== expectedRevision || current.state === 'revoked') return { conflict: true, card: current }; if (!fields || typeof fields.summary !== 'string' || fields.summary.length > 500 || typeof fields.project !== 'string' || fields.project.length > 100 || typeof fields.ticket !== 'string' || fields.ticket.length > 100 || !['','ticket-design','implementation','review','acceptance'].includes(fields.desiredPhase) || !['','design-only','to-pr'].includes(fields.endpoint) || typeof fields.mergeRequested !== 'boolean' && fields.mergeRequested !== undefined || typeof fields.deployRequested !== 'boolean' && fields.deployRequested !== undefined || typeof fields.mergeTarget !== 'string' && fields.mergeTarget !== undefined || typeof fields.deployTarget !== 'string' && fields.deployTarget !== undefined) throw Error('工程卡片输入无效。'); const original = fields.original || current.content.original; const inherited = current.content.extraAuthorization ?? explicitAuthorization(original); const extraAuthorization = Object.fromEntries(['merge','deploy'].map(kind => { const requested = fields[`${kind}Requested`] ?? Boolean(inherited[kind]?.requested); const target = (fields[`${kind}Target`] ?? inherited[kind]?.target ?? '').trim().slice(0,200); return [kind, requested ? { requested: true, target, status: target ? 'explicit' : 'needs_clarification' } : false]; })); const candidate = { project: fields.project, ticket: fields.ticket, noTicket: fields.noTicket === true, summary: fields.summary, desiredPhase: fields.desiredPhase, endpoint: fields.endpoint, extraAuthorization }; const content = await this.content(original,candidate); const edited = this.store.edit(cardId,expectedRevision,content); return edited.conflict ? edited : this.refresh(cardId); }
  confirm(cardId, expectedRevision, source) { return this.store.confirm(cardId,expectedRevision,source); }
  revoke(cardId, expectedRevision) { return this.store.revoke(cardId,expectedRevision); }
  async refresh(cardId) { const card = this.store.get(cardId); if (!card) throw Error('工程卡片不存在。'); let workflow = card.content.resolution.status === 'verified_existing' ? { phase: null, revision: null, assessment: 'source_unavailable', observedAt: observedAt() } : null; if (card.content.resolution.status === 'verified_existing' && this.workflowSource?.observe) { try { workflow = await this.workflowSource.observe(card.content.ticket); } catch { workflow = { phase: null, revision: null, assessment: 'source_unavailable', observedAt: observedAt() }; } } return this.store.observe(cardId,workflow,card.content.ticket?.url ?? (card.content.resolution.status === 'explicit_new_requirement' ? `${card.content.repository}/new-requirement` : null)); }
}

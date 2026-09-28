import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const kinds = new Set(['repository-test','git-subject','harness-run','review',
  'external-observation','agent-session']);
const hex = value => typeof value==='string' && /^[a-f0-9]{64}$/u.test(value);

export function issueAcceptanceCriteria(body) {
  if (typeof body!=='string') return null;
  if ([...body.matchAll(/^## Acceptance criteria[ \t]*$/gimu)].length!==1) return null;
  const sections=[...body.matchAll(/^## Acceptance criteria[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gimu)];
  if (sections.length!==1) return null;
  const lines=sections[0][1].split(/\r?\n/u).filter(line=>/^\s*- \[[ xX]\] /u.test(line));
  if (!lines.length || lines.length>32) return null;
  const texts=lines.map(line=>line.replace(/^\s*- \[[ xX]\] /u,''));
  return texts.every(text=>text.trim())
    ? texts.map((text,index)=>({criteria_ref:`AC${index+1}`,text})) : null;
}

export function notesAcceptancePlan(content,issueRef,criteria) {
  if (typeof content!=='string' || typeof issueRef!=='string' || !criteria) return null;
  if ([...content.matchAll(/^## Acceptance Evidence Plan[ \t]*$/gmu)].length!==1) return null;
  const blocks=[...content.matchAll(/^## Acceptance Evidence Plan[ \t]*\r?\n```json\r?\n([\s\S]*?)\r?\n```[ \t]*$/gmu)];
  if (blocks.length!==1) return null;
  let plan;
  try { plan=JSON.parse(blocks[0][1]); } catch { return null; }
  if (!plan || Array.isArray(plan) || Object.keys(plan).sort().join(',')
    !=='criteria,criteria_sha256,issue_ref,schema_version'
    || plan.schema_version!==1 || plan.issue_ref!==issueRef
    || !hex(plan.criteria_sha256)
    || plan.criteria_sha256!==digest(JSON.stringify(criteria))
    || !Array.isArray(plan.criteria) || plan.criteria.length!==criteria.length) return null;
  for (const [index,item] of plan.criteria.entries()) {
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',')
      !=='criteria_ref,source_kind,text' || item.criteria_ref!==criteria[index].criteria_ref
      || item.text!==criteria[index].text || !kinds.has(item.source_kind)) return null;
  }
  return plan;
}

export function candidateMatchesPlan(candidate,plan) {
  return Array.isArray(candidate) && candidate.length===plan.criteria.length
    && candidate.every((item,index)=>item?.criteria_ref===plan.criteria[index].criteria_ref
      && (item.source_kind===plan.criteria[index].source_kind
        || item.source_kind==='external-observation'
          && plan.criteria[index].source_kind!=='external-observation'));
}

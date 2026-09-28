import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Packaged Desktop keeps this explicit wire contract beside its decoder.
export const preparationConflictSources = new Map([
  ['PREPARATION_PATH_OCCUPIED','git-worktree'],
  ['PREPARATION_BRANCH_OCCUPIED','git-worktree'],
  ['PREPARATION_BRANCH_CONFLICT','git-worktree'],
  ['PREPARATION_WORKTREE_CONFLICT','git-worktree'],
  ['PREPARATION_GIT_IDENTITY_CONFLICT','git-worktree'],
  ['PREPARATION_REPOSITORY_CONFLICT','git-worktree'],
  ['PREPARATION_WORKTREE_ROOT_CONFLICT','git-worktree'],
  ['PREPARATION_BASELINE_CONFLICT','harness-registration'],
  ['PREPARATION_HARNESS_CONFLICT','harness-registration'],
  ['PREPARATION_WORKFLOW_CONFLICT','harness-workflow'],
  ['PREPARATION_CHECKPOINT_CONFLICT','local-checkpoint'],
]);

export async function getEngineeringReceipt(url,input) {
  const client = new Client({ name:'yuki-link-desktop-companion',version:'1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const result = await client.callTool({name:'get_companion_engineering_receipt',arguments:input});
    if (result.isError || !result.structuredContent || result.structuredContent.schema_version !== 1)
      throw Error('YCA typed receipt unavailable');
    return result.structuredContent;
  } finally { await client.close().catch(()=>{}); }
}

async function preparationCall(url,name,input) {
  const client = new Client({ name:'yuki-link-desktop-preparation',version:'1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const result = await client.callTool({name,arguments:input});
    if (result.isError) {
      const code = result.structuredContent?.error?.code;
      if (typeof code === 'string' && preparationConflictSources.has(code)) {
        const error = Error(code);
        error.code = code;
        throw error;
      }
      throw Error('YCA typed preparation receipt unavailable');
    }
    if (result.structuredContent?.schema_version !== 1)
      throw Error('YCA typed preparation receipt unavailable');
    return result.structuredContent;
  } finally { await client.close().catch(()=>{}); }
}
export const prepareNewRequirement = (url,input) => preparationCall(url,'prepare_companion_new_requirement',input);
export const getPreparationReceipt = (url,input) => preparationCall(url,'get_companion_preparation_receipt',input);
export async function getContinuationReceipt(url,input) {
  const client=new Client({name:'yuki-link-desktop-continuation',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const result=await client.callTool({name:'get_companion_continuation_receipt',
      arguments:{schema_version:1,...input}});
    if (result.isError) {
      const detail=result.structuredContent?.error;
      const error=Error(typeof detail?.code==='string' ? detail.code:'COMPANION_CONTINUATION_RECEIPT_UNAVAILABLE');
      error.code=typeof detail?.code==='string' ? detail.code:'COMPANION_CONTINUATION_RECEIPT_UNAVAILABLE';
      error.source_refs=Array.isArray(detail?.details?.source_refs) ? detail.details.source_refs.slice(0,8):[];
      throw error;
    }
    if (result.structuredContent?.schema_version!==1)
      throw Error('COMPANION_CONTINUATION_RECEIPT_INVALID');
    return result.structuredContent;
  } finally { await client.close().catch(()=>{}); }
}

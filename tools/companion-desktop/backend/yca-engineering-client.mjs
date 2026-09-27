import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
    if (result.isError || result.structuredContent?.schema_version !== 1)
      throw Error('YCA typed preparation receipt unavailable');
    return result.structuredContent;
  } finally { await client.close().catch(()=>{}); }
}
export const prepareNewRequirement = (url,input) => preparationCall(url,'prepare_companion_new_requirement',input);
export const getPreparationReceipt = (url,input) => preparationCall(url,'get_companion_preparation_receipt',input);

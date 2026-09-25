const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const EFFORTS = new Set(['low', 'high', 'max']);

export function deepSeekProvider(key, fetcher = fetch) {
  if (typeof key !== 'string' || !key.trim()) return null;
  return async ({ messages, thinking, signal }) => {
    const enabled = thinking?.enabled === true;
    if (enabled && !EFFORTS.has(thinking.effort)) throw Error('思考档位无效。');
    const request = { model: 'deepseek-flash', messages, thinking: { type: enabled ? 'enabled' : 'disabled' }, stream: false };
    if (enabled) request.reasoning_effort = thinking.effort;
    const start = performance.now();
    const deadline = AbortSignal.timeout(enabled ? 300000 : 60000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    const response = await fetcher(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(request), signal: combined });
    combined.throwIfAborted();
    if (!response.ok) throw Error(response.status === 401 ? 'DeepSeek 凭据无效，请检查设置。' : `DeepSeek 服务暂不可用（HTTP ${response.status}）。`);
    const body = await response.json();
    combined.throwIfAborted();
    const fullResponseMs = Math.round(performance.now() - start);
    const choice = body?.choices?.[0];
    const message = choice?.message;
    const content = message?.content;
    const reasoning = message?.reasoning_content;
    if (body?.choices?.length !== 1 || choice?.finish_reason !== 'stop' || (message?.role && message.role !== 'assistant') || message?.tool_calls || message?.function_call || message?.refusal || typeof content !== 'string' || !content.trim() || (reasoning !== undefined && reasoning !== null && typeof reasoning !== 'string')) throw Error('DeepSeek 没有返回完整的文字回复。');
    return { content: content.trim(), reasoningContent: typeof reasoning === 'string' && reasoning.trim() ? reasoning : null, metadata: { source: 'deepseek', requestedThinking: enabled ? thinking.effort : 'off', requestModel: request.model, responseModel: typeof body.model === 'string' ? body.model : null, fullResponseMs, finishReason: choice.finish_reason, reasoningTruncated: false } };
  };
}

export function previewProvider() { return async ({ messages }) => ({ content: `离线预览回复：已收到「${messages.at(-1).content}」。这不是 DeepSeek 回复。`, reasoningContent: null, metadata: null }); }

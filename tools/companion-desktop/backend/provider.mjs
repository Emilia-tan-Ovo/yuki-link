const ENDPOINT = 'https://api.deepseek.com/chat/completions';
export function deepSeekProvider(key, fetcher = fetch) {
  if (typeof key !== 'string' || !key.trim()) return null;
  return async ({ text, history, system }) => {
    const response = await fetcher(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text }], thinking: { type: 'disabled' }, stream: false }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(response.status === 401 ? 'DeepSeek 凭据无效，请检查设置。' : `DeepSeek 服务暂不可用（HTTP ${response.status}）。`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw Error('DeepSeek 没有返回可显示的文字。');
    return content;
  };
}

export function previewProvider() { return async ({ text }) => `离线预览回复：已收到「${text}」。这不是 DeepSeek 回复。`; }

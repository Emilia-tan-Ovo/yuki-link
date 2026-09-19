// 本机精简证据快照 -> 冻结 Markdown。无网络、模型调用或 Git 写入。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const limit = 64 * 1024;
const fail = message => { throw new Error(message); };
const statuses = ['recorded', 'none', 'pending', 'unknown', 'not-applicable'];
function object(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_FIELDS');
}
function text(value, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail('INVALID_TEXT');
}
function list(value, validate, max = 32) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_LIST');
  value.forEach(validate);
}
function nullable(value) { if (value !== null) text(value); }
function timestamp(value) {
  text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_TIME');
}
function fact(value, stage = false) {
  object(value, ['status', 'summary', 'sources', ...(stage ? ['sessions'] : [])]);
  if (!statuses.includes(value.status)) fail('INVALID_STATUS');
  text(value.summary);
  list(value.sources, item => text(item));
  if (['recorded', 'none'].includes(value.status) && !value.sources.length) fail('SOURCE_REQUIRED');
  if (stage) list(value.sessions, session => {
    object(session, ['id', 'runs', 'model', 'reasoning']);
    nullable(session.id); list(session.runs, item => text(item));
    nullable(session.model); nullable(session.reasoning);
  });
}
function validate(data) {
  object(data, ['schema_version', 'ticket', 'issue', 'sources', 'observed_at', 'worktree', 'branch',
    'fixed_point', 'head', 'summary', 'stages', 'metrics', 'failures', 'findings', 'interventions', 'delivery', 'evidence']);
  if (data.schema_version !== 1) fail('UNSUPPORTED_SCHEMA');
  if (typeof data.ticket !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(data.ticket)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(data.ticket)) fail('INVALID_TICKET');
  for (const key of ['issue', 'worktree', 'branch', 'summary']) text(data[key]);
  for (const key of ['fixed_point', 'head']) {
    if (typeof data[key] !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(data[key])) fail('INVALID_COMMIT');
  }
  timestamp(data.observed_at);
  list(data.sources, item => text(item));
  if (data.sources.length < 2) fail('TICKET_SPEC_SOURCES_REQUIRED');
  object(data.stages, ['implementation', 'review', 'acceptance']);
  for (const stage of Object.values(data.stages)) fact(stage, true);
  for (const key of ['metrics', 'failures', 'findings', 'interventions']) fact(data[key]);
  object(data.delivery, ['pr', 'merge']);
  fact(data.delivery.pr); fact(data.delivery.merge);
  const ids = new Set();
  list(data.evidence, item => {
    object(item, ['id', 'location', 'status', 'observed_at', 'identity']);
    text(item.id, 80); timestamp(item.observed_at); nullable(item.identity);
    if (ids.has(item.id)) fail('DUPLICATE_EVIDENCE');
    ids.add(item.id);
    if (!['available', 'missing', 'stale', 'unknown', 'not-applicable'].includes(item.status)) fail('INVALID_EVIDENCE_STATUS');
    nullable(item.location);
    if (item.status === 'not-applicable' ? item.location !== null : item.location === null && item.status !== 'unknown') fail('INVALID_EVIDENCE_LOCATION');
    if (item.location !== null && (/^[a-z][a-z0-9+.-]*:\/\//iu.test(item.location) || item.location.startsWith('\\\\') || item.location.startsWith('//'))) fail('LOCAL_EVIDENCE_ONLY');
  });
  if (!data.evidence.length) fail('EVIDENCE_REQUIRED');
}

// 所有可写路径从显式 repo 根导出；拒绝链接和非普通文件。
function safeRelative(repo, relative, createDirectories = false) {
  let current = repo;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    const directory = i < parts.length - 1;
    if (!stat && directory && createDirectories) {
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat && (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1))) fail('UNSAFE_PATH');
    if (!stat && directory && !createDirectories) fail('MISSING_DIRECTORY');
  }
  return current;
}
function readInput(repo, input) {
  const absolute = path.resolve(input);
  const relative = path.relative(repo, absolute).split(path.sep).join('/');
  if (!relative.startsWith('.local/') || relative.includes('../')) fail('INPUT_MUST_BE_REPO_LOCAL');
  const filename = safeRelative(repo, relative);
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail('INPUT_TOO_LARGE_OR_NOT_FILE');
    const buffer = Buffer.alloc(limit + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > limit) fail('INPUT_TOO_LARGE_OR_NOT_FILE');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { fs.closeSync(fd); }
}
function observe(repo, data) {
  // 仅 stat 显式位置，不读取 raw 内容；stale 是上游核验的内容/适用性结论。
  for (const item of data.evidence) {
    item.observed_at = data.observed_at;
    if (item.status === 'not-applicable' || item.location === null) continue;
    try {
      const stat = fs.lstatSync(path.resolve(repo, item.location));
      item.status = stat.isFile() ? (item.status === 'stale' ? 'stale' : 'available') : 'unknown';
    } catch (error) {
      item.status = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unknown';
    }
  }
  return data;
}
// 摘要全部作为文字转义；不允许输入伪造标题、链接或内嵌 HTML。
const md = value => (value === null ? 'unknown' : String(value)).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/[\\`*_{}\[\]()#+|~]/gu, '\\$&');
function render(data) {
  const lines = [`# ${md(data.ticket)} — Closeout archive`, '',
    '> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。', '',
    `- 观察时间：${md(data.observed_at)}`, `- Ticket / Issue：${md(data.ticket)} / ${md(data.issue)}`,
    `- 来源：${data.sources.map(md).join('；')}`, `- worktree：${md(data.worktree)}`,
    `- branch：${md(data.branch)}`, `- fixed point：${md(data.fixed_point)}`, `- HEAD：${md(data.head)}`,
    '', '## 过程与结果', '', md(data.summary)];
  function section(title, value) {
    lines.push('', `## ${title}`, '', `- 状态：${value.status}`, `- 摘要：${md(value.summary)}`,
      `- 证据来源：${value.sources.length ? value.sources.map(md).join('；') : 'unknown / 尚无来源'}`);
  }
  for (const name of ['implementation', 'review', 'acceptance']) {
    const stage = data.stages[name];
    section(name, stage);
    if (!stage.sessions.length) lines.push(`- session / run：未记录；阶段状态 ${stage.status}，不推断已执行。`);
    for (const session of stage.sessions) lines.push(`- session：${md(session.id)}；run：${session.runs.length ? session.runs.map(md).join('、') : 'unknown'}；model：${md(session.model)}；reasoning：${md(session.reasoning)}`);
  }
  for (const [key, label] of [['metrics', '代表性耗时 / 调用及口径'], ['failures', '失败 / 重试'],
    ['findings', 'Findings 与修复'], ['interventions', '人工介入点']]) section(label, data[key]);
  section('PR', data.delivery.pr); section('Merge', data.delivery.merge);
  lines.push('', '## Raw evidence（仅引用）');
  for (const item of data.evidence) lines.push('', `- ${md(item.id)}：${item.status}`,
    `  - 本机位置：${item.location === null ? (item.status === 'not-applicable' ? 'not-applicable' : 'unknown') : md(item.location)}`,
    `  - 观察时间：${md(item.observed_at)}；适用内容 / 来源身份：${md(item.identity)}`);
  return `${lines.join('\n')}\n`;
}
function publish(repo, ticket, content) {
  if (Buffer.byteLength(content, 'utf8') > limit) fail('ARCHIVE_TOO_LARGE');
  const relative = `.workflow/history/${ticket}.md`;
  const destination = safeRelative(repo, relative, true);
  if (fs.existsSync(destination) && fs.statSync(destination).size <= limit
    && fs.readFileSync(destination, 'utf8') === content) return relative;
  const temporary = path.join(path.dirname(destination), `.${ticket}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    safeRelative(repo, relative);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return relative;
}
try {
  const [command, root, input, ...extra] = process.argv.slice(2);
  if (!['observe', 'generate'].includes(command) || !root || !input || extra.length) fail('Usage: node closeout-archive.mjs <observe|generate> <repo> <repo/.local/input.json>');
  const repo = fs.realpathSync(root);
  const marker = fs.lstatSync(path.join(repo, '.git'));
  if (marker.isSymbolicLink() || !(marker.isDirectory() || marker.isFile())) fail('REPOSITORY_ROOT_REQUIRED');
  const data = readInput(repo, input);
  validate(data);
  if (command === 'observe') console.log(JSON.stringify(observe(repo, data), null, 2));
  else {
    const content = render(data);
    const archive = publish(repo, data.ticket, content);
    console.log(JSON.stringify({ status: 'generated', archive, sha256: createHash('sha256').update(content).digest('hex') }));
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: error.message }));
  process.exitCode = 1;
}

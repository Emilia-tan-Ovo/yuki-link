# COMPANION-014 Implementation Notes

Source: GitHub #140 / Source Spec #125 Post-M1 Addendum US37 / AC16
Fixed point: `c7db15b881cce60f23e4fb51ebb4ad7147383934`

## Implementation Decisions

- **Thinking settings：**`settings.json` 新增 `thinking: { schemaVersion: 1, enabled: false, effort: 'high' }`。Yuki 产品默认显式关闭；effort 仅允许 `low/high/max`，关闭时保留最近一次 effort，重新开启恢复该值。旧设置缺字段时内存默认 off/high，不在 load 时主动重写文件；非法保存值拒绝且不覆盖 committed snapshot。继续复用 013 的同一 SettingsStore commit queue。
- **发送时快照：**renderer 不能直接给 worker 注入 thinking 参数；`submittedTurn` 在主进程接受 submit 时从一次 `store.snapshot()` 同时冻结 Role Card + Thinking。thinking 保存 pending 时已接受的请求使用旧 committed 值，rename 成功并 publish 后下一条才使用新值。保存 thinking 不重启 worker、不改 generation、不取消正在进行请求。
- **IPC / 设置 UI：**增加专用 thinking load/save 命令与响应；preload 白名单、main trusted sender 规则不变。设置页最小 UI 为“启用思考”+ low/high/max select + 保存状态；关闭时 select 禁用但保留档位。preview 可保存设置，但必须明确不会调用 DeepSeek 或制造思考。
- **Provider Interface：**统一从 string 升级为输入 `{ messages, thinking }`、输出 `{ content, reasoningContent, metadata }`；DeepSeek / preview / 测试 adapter 同一协议。Prompt Composer 仍只负责 messages，不负责 HTTP thinking 参数。
- **DeepSeek 请求：**off 必须显式发送 `thinking:{type:'disabled'}` 且不发送 `reasoning_effort`；on 必须显式发送 `thinking:{type:'enabled'}` + `reasoning_effort: low|high|max`。继续 `deepseek-flash`、`stream:false`，不新增 tools、temperature、presence/frequency penalty 或自动重试。实现前只需定向复核 DeepSeek 官方 thinking / Chat Completions 契约。
- **Provider 响应校验：**最终 `content` 必须是非空白 string；`reasoning_content` 只接受 string / null / missing，空白归 null，其他类型视为 malformed。只接受可作为完整普通文本回合的成功响应；`finish_reason=length`、过滤/中断/工具输出、content 缺失等整轮失败且不写 DB，不把 partial reasoning 升级为答案。thinking-on 没有 reasoning 但 final 完整时允许回合成功，但不计“真实思考展示验收通过”。thinking-off 若 provider 意外返回 reasoning，保留并如实标注，不伪称 off 已被服务端遵守。
- **Metadata：**仅保存白名单 V1：`source`、`requestedThinking`（off/low/high/max）、`requestModel`、`responseModel`、`fullResponseMs`、`finishReason`、`reasoningTruncated`。不保存 raw response、headers、Key、完整 prompt/messages、token 明细、首 token 时间或所谓“思考时长”。`fullResponseMs` 只表示 provider fetch 前到完整 response body 解析结束的耗时。
- **SQLite migration：**现有 `messages` 同表新增 nullable `reasoning_content TEXT` 与 `response_metadata TEXT`；Reasoning 与 final text 物理分离，metadata 只保存白名单 JSON。使用 `PRAGMA user_version`：现有未版本化 DB（0）事务性迁移到 v1；新库直接得到 v1；v1 重开幂等；更高未知版本或版本/schema 不一致受控拒绝，不删库、不静默重建。迁移失败 rollback 并给受控错误。
- **双历史投影：**`history()` 收窄为模型/Memory 安全出口，只 SELECT/返回 `{role,text}`，绝不含 reasoning/metadata；新增 `displayHistory()` 给 renderer，返回原 UI 字段 + assistant 的 `reasoningContent/metadata`。即时 reply 与 reopen history 使用同一 display row 形状。不要做 `includeReasoning=true` 这类容易误用的通用开关。
- **整轮事务：**provider 完整成功后再构造 user + assistant，并一次事务写入；assistant 附带 reasoning/metadata，user 的附属列必须为空。DB append 失败整轮 rollback，不发成功 reply；本地持久化失败不得伪装成远端 provider 失败。
- **Reasoning 本地预算：**单条 reasoning 最多保存 **256 KiB UTF-8**。只有在 final response 本身已确认完整后，超限 reasoning 才截取可完整解码的 UTF-8 前缀并标 `reasoningTruncated=true`；final content 正常保留。UI 明确显示“思考未完整保存”，不能静默冒充完整。原完整 reasoning 不旁路写日志/文件。
- **UI：**assistant 仅在 `reasoningContent` 非空时渲染原生 `<details>` 思考块，默认折叠；展开内容纯 textContent + pre-wrap，不执行 Markdown/HTML/链接。无 reasoning、旧消息或 preview 不制造假思考。普通消息可显示“请求档位：关闭/low/high/max · 完整回复耗时：…”，不得叫“思考耗时”或“首 token 延迟”。展开状态只在当前 renderer 生命周期内保留，不持久化。
- **Timeout：**off 保持 60s；thinking-on 使用 300s（low/high/max 一致）。超时视为该轮失败、无消息写入、不自动重试、不自动降档，也不宣称服务端一定已取消。
- **Projection isolation：**reasoning 只作为 display/persistence 附属数据。必须用仅存在于 reasoning 的 synthetic marker 验证：当前 UI/SQLite/reopen 可见；下一轮 `history()`、Prompt Composer Recent、真实 adapter request body 和 013 Memory seam 都不可见该 marker。#127 Memory schema 不因 014 改动。
- **Failure / reconnect：**输入/busy/settings 前置拒绝不触发 provider，也不把 service 改 unknown；真实 provider HTTP/network/timeout/malformed 失败无新消息并使真实 provider 状态 unknown；generation/reconnect 继续沿用现有 transport，不新增 retry / durable request engine。旧 worker 结果不得触发重复调用。
- **真实验收：**实现、Review 和 deterministic package/UI 验收完成后，需 Owner 单独授权 **1 次 thinking-on/high + 1 次 thinking-off** 真实请求，不自动增加第三次。记录实际请求字段摘要、reasoning/content 分离、完整回复耗时、requested/response model、重开回看；第二轮实际 request 必须不包含上一轮 reasoning。low/max 用确定性 fixture，不额外付费调用。

## Deferred Details

- helper 文件名、UI 排版/秒数精度、错误常量名、fixture 放置、migration 故障注入方式可按实现期最小改动决定。
- 不做 streaming/SSE、tools/function calling、DSH/Codex reasoning UI、Reasoning Memory / Memory engine、#127 schema 修改、Live2D/Voice、微信、自动重试、全历史分页或通用网络 body 上限系统。
- 如果官方模型拒绝已确认字段或 DB 出现未知版本，先报告真实 blocker，不静默换模型、降 effort、删数据或修改产品语义。

### Context Plan

- **Core:** GitHub #140 / US37 / AC16；本 Notes；`AGENTS.md`；fixed point；`tools/companion-desktop/backend/{provider,dialogue-pipeline,session,sqlite-memory,prompt-composer,worker}.mjs`；`tools/companion-desktop/desktop/electron/{settings-store,submit-snapshot,main,preload,transport}.mjs/cjs`；`desktop/{index.html,renderer.js,style.css}`。
- **Core tests:** provider / settings-store / session / prompt-composer / renderer；新增小型 `sqlite-memory.test.mjs`；packaged-smoke 仅作后置机械验收。
- **Related:** #125 仅 US37/AC16 + ID01/ID07/AC14；`docs/implementation-notes/COMPANION-013.md` 仅 Prompt/Recent/Memory seam；DeepSeek 官方 Thinking Mode 与 Chat Completions 当前字段。
- **Retrieval:** `submittedTurn`、`history()`、`displayHistory()`、`appendTurn`、`onProviderFailure`、`finish_reason`、`reasoning_content`、`PRAGMA user_version`。
- **Expansion triggers:** HEAD/fixed point 漂移、#127 已改变历史/Memory interface、DB 出现未知版本、官方字段被拒绝、或现有 generation 无法保持当前 reconnect 语义；遇到后先报告 delta，不自行扩票。

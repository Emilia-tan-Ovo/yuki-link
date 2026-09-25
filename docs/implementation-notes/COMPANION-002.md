# COMPANION-002 Implementation Notes

Source: GitHub #127；Source Spec #125 US08–11、US32、ID01、ID07、AC03、AC13、AC14（本票只验桌面段）。

Fixed point: `d63947f4578899a833f4b901078b1de144f9ed12`

状态：本地实现已提交前验证；定向测试覆盖迁移、事务、召回、上下文失效和 renderer 管理状态。完整 package / packaged smoke 与真实 DeepSeek 均未在本 implementation session 执行。

## Implementation Decisions

- **唯一数据归属：**继续使用 Desktop 用户数据目录内的 `conversation.sqlite`，由现有 `BackendSession` / worker 持有；另建陪伴记忆表，不把长期事实塞进 `messages`、`settings.json`、工程记忆或角色卡。保留 #126 的单一持续对话与可回看历史。此处的 SQLite 是后续 009 可复用的本地数据边界，不在本票声称跨端共享已经成立。
- **三类来源：**`history()` 是近期已提交的 user/assistant 最终文本；`Companion Memory` 是显式写入、仍 active 且本轮相关的长期合成事实；工程事实/卡片由未来的工程来源提供，本票不查询或注入。reasoning、角色卡、工程日志、凭据都不是可提取记忆来源。UI 与代码分别命名，不用一个通用 `memory` 数组混装。
- **写入触发：**仅显式用户操作会写入：聊天框受限的“记住：…”指令，或记忆管理区从现有用户消息选取/编辑出一条简短事实或偏好再保存。事实文本由用户确认，不从每轮聊天或模型回复自动抽取；无模型智能识别的暗示。拒绝空白、控制字符、超长内容及来源不明输入；既有消息作为来源时只引用已提交 user message ID，不复制整段聊天。未成功提交时不出现“已记住”。
- **纠正与遗忘入口：**设置中的“陪伴记忆”区列出 active 事实、来源类型及时间，提供“更正”“忘记”；更正需选定稳定 ID 并填写替代事实，遗忘需选定 ID。聊天框中明确的“更正记忆/忘记记忆”请求进入同一管理流程，让用户选定目标；简单、无歧义的显式句式可以预填，不凭模糊匹配直接改库。缺目标、歧义或不支持的自由表达只提示选择/确认，不转交模型让其自称操作成功。最终成功文案只由 worker 返回的已提交结果驱动。记住/管理操作是本地命令，不调用 DeepSeek；普通对话仍走原 `submit`。
- **现有 Composer 契约：**`DialoguePipeline` 每次 compose 前从 store 取得小集合 `{schemaVersion:1, entries:[{id,text,sourceRef}]}`，传给唯一 `composePrompt`；Composer / provider 不查库、不负责召回、不变更 Core 优先级。`sourceRef` 是本地 opaque 引用，不能携带聊天原文、路径或工程日志。`runtimeCapabilities().memoryManagement` 只在 worker 成功加载本地 Memory 能力时为 true；真实 provider 是否已验证仍独立报告。
- **有限相关召回：**store 只查询 active 行，按用户当前文本与事实文本/可选短主题词的确定性中文字符片段及词面重合排序，以最近更新时间和稳定 ID 打破平局；无相关命中则传空集合，不退化成整个库或“最近 N 条”。最多 5 条、每条短文本、总输入预算低于 Composer 现有 20 条 / 8000 字上限，超限在查询层受控拒绝或截断候选选择，绝不截断事实文本后冒充原文。先用合成词面场景验收；无语义匹配承诺，也不引入 RAG、embedding 或第二个模型调用。
- **纠正原子性：**在一个 SQLite 事务中核对目标仍 active，清除旧行内容并标 `superseded`，插入新 stable ID 的 active 行及 `supersedes_id`，同时推进下述近期上下文起点。后续只召回 active 行；重复/过期 ID 返回冲突，不悄悄覆盖另一次修改。旧 ID 用于解释版本链，不保留旧事实文本。
- **遗忘原子性：**在一个事务中把目标标 `forgotten`、清空事实文本/主题词并推进近期上下文起点。只声称“已从本机有效陪伴记忆移除，后续不再作为记忆使用”。历史消息的可回看副本仍在 `messages`；SQLite 已释放页、备份以及提供商日志不能承诺物理抹除或远端删除。本票不自动导入/扫描私人旧聊天，不清理模型日志。
- **近期历史失效：**纠正或遗忘事务记录一个单调前进的 `recent_context_after_rowid`，取当时 `messages` 的最大 rowid。供模型的 `history()` 只投影该起点之后的近期最终文本；`displayHistory()` 不变，旧聊天仍能由用户回看。这个保守的整段上下文切断，防止旧事实绕过 tombstone 从最近 20 条重新进入 prompt；UI 说明纠正/遗忘后近期聊天上下文从此重新接续。更正的新事实由 active Memory 独立提供。其他已提交 active 记忆不因此删除。
- **并发和提交点：**所有记忆命令在同一 worker/store 内执行，session 忙于 provider 回合时拒绝或等待到该轮结束后再受理，不能让已接受的旧 prompt 在“遗忘成功”之后才返回。成功只在 SQLite `COMMIT` 后回复；写入失败 rollback、保持旧有效状态并返回本地错误，不返回成功。重连按现有 generation 过滤旧 worker 回包；不通过渲染层缓存作为事实来源。

## Schema

在 v1 `messages` 保持原样的基础上，把 `PRAGMA user_version` 事务性升至 v2；新库直接建 v2，v0 经原 v1 迁移路径再升 v2，v1/v2 重开幂等，未知更高版本或结构不符受控拒绝，不删库重建。

| 存储 | 必需字段 | 用途 |
| --- | --- | --- |
| `companion_memories` | `id` UUID 主键；`text` nullable；`topic` nullable；`state` = active/superseded/forgotten；`source_kind` = explicit_chat/selected_user_message；`source_ref` opaque ID；`created_at`、`updated_at`；`supersedes_id` nullable FK | active 行必须有非空短文本；失效行文本/主题为空；更正建立版本链，遗忘保留不含事实内容的 tombstone。`source_ref` 只指本机操作 ID 或已有 user message ID，不存完整 prompt。 |
| `companion_context` | singleton key；`recent_context_after_rowid` 非负整数 | 与纠正/遗忘同事务提交的近期模型上下文起点；缺省 0。 |

不增加冗余 `version`、confidence、embedding、全文日志列；新 ID + `supersedes_id` + state 已能表达版本关系。索引仅覆盖 active 查询与 `supersedes_id`；具体 SQL 约束/字符上限按实现期最小确定，但必须在 DB 和入口双层防止无效 active 行及超出 Composer 预算。`source_kind/source_ref` 是出处说明，不是授权或可信事实证明。

## 关键数据流

1. **记住：**renderer 发显式操作 → main 校验可信 sender / generation 并转给 worker → session 校验来源和文本 → store 事务写 active 行 → worker 回已提交 ID → UI 显示成功。
2. **相关召回：**普通 `submit` → session 获取本轮已提交 memory 候选及受 cutoff 限制的 `history()` → `DialoguePipeline` 调唯一 Composer → provider 消费 composed messages → 原有 user/assistant 整轮持久化。Prompt provenance 的 memory IDs 可供测试，不写全量 prompt 日志。
3. **更正/遗忘：**用户选 active ID → worker 校验 → 单事务失效旧行、必要时插入新行，并推进 history cutoff → 提交后回状态；下一轮重新查询 active 行和 cutoff，不沿用上轮缓存。
4. **重开：**Electron 沿用同一 userData → worker 重开同一 SQLite，验证 v2 → `displayHistory()` 供界面回看，active 记忆和 cutoff 从 DB 重新加载 → 后续相关提问走同一召回路径。离线 preview 可验证本地管理与 prompt 装配，不能算真实 DeepSeek 回复。

## 失败语义与可解释性

- 启动迁移、记忆读取或 Composer 输入校验失败时，相关对话受控失败；不能静默以空 Memory 继续并声称已接续。更正/遗忘写失败时返回失败，原事实与 cutoff 保持事务前状态。
- 目标已失效、ID 不存在或请求歧义时提示当前状态并要求重选；不生成伪成功。UI 显示“有效/已更正/已遗忘”的本地状态与来源摘要；普通历史和工程事实各有独立标签。
- 对同一轮已发出的远端请求无法撤回已提交的 prompt；因此记忆变更在 session 忙时不能报告已生效。对尚未接入的微信、外部副本及模型日志如实标“本票未验证/不可由本机操作删除”。

## 测试计划

- `tools/companion-desktop/test/sqlite-memory.test.mjs`：v1→v2 保留旧消息、v2 重开；合成事实写入、纠正和遗忘事务后 active 查询及 cutoff；故障注入时回滚，不误报成功。
- `tools/companion-desktop/test/session.test.mjs` 与 `tools/companion-desktop/test/prompt-composer.test.mjs`：一次合成记住→相关命中→更正后旧文本和旧近期历史均不入 provider messages→遗忘后新文本也不入→关闭/重开后仍遵循状态；无关记忆不注入，reasoning/工程文本不被提取。只检验确定性 seam，不断言模型自由生成一定遵从。
- `tools/companion-desktop/test/renderer.test.mjs` 加一个入口级管理路径：草稿、目标选择、提交中、成功/失败文案及 generation；与既有 Electron IPC/worker 边界一起验证成功发生在持久化后。实现后由确定性打包/UI 验收核对一次 reopen；不扩成多设备或全生命周期矩阵，不调用真实 DeepSeek。

## Context Plan

- **Core:** GitHub #127 AC；本 Notes；`AGENTS.md`；fixed point；`tools/companion-desktop/backend/{prompt-composer,session,dialogue-pipeline,sqlite-memory,worker}.mjs`；`tools/companion-desktop/desktop/electron/{main,preload,transport}.mjs/cjs`；`tools/companion-desktop/desktop/{renderer.js,index.html,style.css}`；同目录直接相关 tests。
- **Related:** #125 US08–11/US32、ID01/ID07、AC03/AC13/AC14；`docs/implementation-notes/COMPANION-013.md` 的 Composer/Memory injection contract；`docs/implementation-notes/COMPANION-014.md` 的 reasoning 隔离与 SQLite v1；`docs/implementation-notes/COMPANION-001.md` 的单持续对话/重开语义。
- **Retrieval:** `normalizeMemory`、`history()`、`displayHistory()`、`appendTurn`、`PRAGMA user_version`、`submittedTurn`、`generation`、`runtimeCapabilities()`。历史 AAAAGENT 实现只有当前接口不足时才定向查看。
- **Expansion triggers:** fixed point 变化；实际库版本/结构与 v1 不符；旧历史仍能绕过 cutoff 进入 composed messages；管理命令和 in-flight submit 无法保持提交顺序；009 要求跨端存储时另票设计，不能在本票扩成同步系统。

## Out of Scope

自动抽取或智能总结每轮对话、语义向量召回、通用 RAG、私人聊天导入、微信/009 跨端验证、DSH/YCA 工程执行、工程日志全文注入、全量历史清理、外部模型日志删除、真实 DeepSeek 调用及长期回复质量承诺。

## Owner 产品决策

无新增未决产品决策。上述显式写入及受限自然语言入口，是在 #127 “无新增产品未决项”、现有 Composer 接口和本票最小路径下的实现提案；若 Owner 另要求任意自由表达都自动识别并提交记忆，那将改变本票范围，应另行确认。

## Implementation delta

- SQLite v2 新增独立 `companion_memories` / `companion_context`；v0/v1 保留原有消息升版，v2 重开验证，未知版本受控拒绝。
- `BackendSession` 在普通对话前从本地 active 记忆做确定性词面召回，最多 5 条，交给既有 Prompt Composer；记忆命令在 provider busy 时拒绝。
- 设置中可显式新增、更正和遗忘，可从已保存的用户消息选择来源并另填简短事实；聊天框只接受受限“记住：…”格式直接写入，其他记忆请求引导到管理区。
- 更正/遗忘同事务清除旧事实文本并推进模型近期历史 cutoff；显示历史仍可回看。worker 在 COMMIT 后回复，renderer 仅凭当前 generation 的成功回包显示成功。
- packaged smoke 路径增添 first 阶段记住/更正及 reopen 阶段读取/遗忘的确定性预览检查；完整打包与运行留给后置验收。

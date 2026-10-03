# HERMES-YCA-001 Implementation Notes — YER 收缩版

状态：2026-10-04 已按 Owner 后续授权完成候选实现和定向验证，Implementation Handoff 交回 Ticket Main；本地 commit 状态与精确 SHA 见 checkpoint。`review_policy=delegated`，独立 Review 与真实链路 Acceptance 均 pending。**Canonical 方向为 Hermes 原生工具 + YER（Yuki Engineering Runtime）**。当前实施结果见文末 Implementation Handoff；下方第 1–9 节保留原设计决策，其中“本轮仅设计/尚未实施”的时态只指此前 design 工作项，不覆盖本次 implementation 授权。

- Ticket：[001-hermes-yca-adapter.md](../tickets/hermes-yca/001-hermes-yca-adapter.md)；正式 tracker：[Issue #178](https://github.com/Emilia-tan-Ovo/yuki-link/issues/178)，`local:HERMES-YCA-001` 保留为原持久化别名。
- #178 已由 Orchestrator 按本 YER refinement 同步，远端 `updated_at=2026-10-03T16:25:40Z`；标题、正文与 Acceptance Criteria 均已改为 Hermes 原生普通工具 + YER 工程 runtime。
- 本 worktree/分支：`codex/hermes-yca-001`；YCA 源码与 HEAD/fixed point：`1b70d076e921915488e5b117a8acc56f5a85e74d`。Hermes checkout 本轮复核仍为 `eb7e8620324b32424c06218f6a28094df2e921f8`、clean；安装包和运行服务状态未验证。
- 只从 Ticket、原 Notes、Owner 指定替换评估及其源码引用恢复。绝对 checkout/报告路径、旧文档快照和当前字节摘要在本 worktree `.local/workflow-state/HERMES-YCA-001.md`；不把旧聊天当工程依据。

## Implementation Notes

### 1. 判断与已确认架构

**收缩在架构上成立，不需要保留 YCA 的通用电脑 Agent 产品面。** durable workflow 的关键保证来自受管授权/工作项、runtime store/journal、进程归属、证据与 reconcile，并不来自对外的 `filesystem_*`、`powershell*`、`git_*` 工具名。但不是删掉 `computer/` 目录就完成抽取：路径保护、工程长任务的进程/输出支持等仍有真实依赖，见第 2 节。

Owner 已确认普通电脑/文件/shell/Git 操作由 Hermes 原生工具在足够时承担；YER 只负责工程职责。Hermes 与 YER 在同机经 **`http://127.0.0.1:<port>` HTTP / Streamable HTTP** 通信，不经过公网、tunnel 或代理。当前 session 由既有受管工作项绑定决定、`destination=main`、Owner native permissions；同一设计工作项继续，不因改名 YER 另起工作项或 generation。

```text
Hermes / Emilia ── 普通操作 ── Hermes 原生电脑 / 文件 / shell / Git
       │
       └─ 工程意图 / Hermes 工程面板
              │ 同机 127.0.0.1 HTTP / Streamable HTTP
              ▼
             YER：授权 → managed launcher → work item / generation
              │                    ↕ execution journal / runtime store
              ├─ backend dispatch → Codex(Sylvia) / 后续 DSH adapter
              └─ 公开事件、工程任务证据、当前/累计 diff、Review/Acceptance
```

Hermes 保有自己的聊天与原生工具事实；YER 是**工程执行**的唯一权威。Git/文件系统是工程内容身份权威。Hermes 工程插件保存明确引用与可丢弃缓存，不复制工程状态机。同一工程工作不双派发到 Hermes native Codex runtime 和 YER。普通操作不启动工程模型；属于工程职责的启动/续发/修复/Review 不用原生 shell 启动 Codex 来绕过 YER。

### 2. 抽取边界与必要依赖

**Proposal（依据已确认范围收敛的实现建议，尚未实施）：先在现有仓库内形成工程专用装配入口和 MCP 工具注册集合，共享原有工程内核；不先复制成第二套 runtime，也不做全仓重命名。** 初期源码路径仍可在 `tools/codex-session-bridge/`，产品名 YER 不要求改写已有 ID、日志 kind、错误码或 runtime 目录。仅隐藏 Hermes 的工具目录不算完成抽取：YER 入口不得为普通操作实例化完整 `ComputerTools` 或依赖旧 Companion/tunnel 服务启动。

| 模块/能力 | 留在 YER 的范围与源码依据 |
| --- | --- |
| durable session/run、幂等请求、单 writer | 必须保留 `tools/codex-session-bridge/src/store.js`、`tools/codex-session-bridge/src/manager.js`、`tools/codex-session-bridge/src/harness/journal.ts`；保留 `sessions.json`、`runs/*.jsonl`、journal/source ID、request 映射、锁和失败持久化语义。 |
| managed workflow 与证据门禁 | 必须保留 `tools/codex-session-bridge/src/orchestration/workflow-agent-launcher.ts`、`tools/codex-session-bridge/src/orchestration/execution-operations.ts`、`tools/codex-session-bridge/src/orchestration/work-items.ts`、`tools/codex-session-bridge/src/orchestration/dispatch-work-item.ts`，及 implementation/review launcher、authority、review-evidence、Workflow/Conversation 模型。 |
| backend 与权限/进程 | 保留 `tools/codex-session-bridge/src/executor.js`、`tools/codex-session-bridge/src/process.js`、`tools/codex-session-bridge/src/permissions.js`、`tools/codex-session-bridge/src/catalog.js`、`tools/codex-session-bridge/src/codex-executable.js`。动态可执行文件/模型/权限按既有 source of truth 刷新，不能由 Hermes UI 的权限标签代替冻结快照。 |
| 工程事实读取 | 保留 `tools/codex-session-bridge/src/harness/changes-source.ts`、`tools/codex-session-bridge/src/harness/workflow-source.ts`、`tools/codex-session-bridge/src/harness/codex-source.ts` 及 context/document/preflight。它们直接读取 Git/文件/报告、核内容哈希，独立于通用 `git_diff/filesystem_read` MCP。 |
| 路径/输出保护 | `tools/codex-session-bridge/src/harness/codex-source.ts` 确实 import `tools/codex-session-bridge/src/computer/paths.js` 的 `PathPolicy`；此基础设施必须共享或抽出保留，同时保留 errors/redact、`tools/codex-session-bridge/src/harness/content-policy.ts`。目录名带 computer 不构成删除理由。 |
| Harness 数据与展示投影 | 保留 `tools/codex-session-bridge/src/harness/harness.ts`、conversations/workflow/changes/presentation、source 与 journal 回放；它们不是单纯旧 UI。移除旧 UI 依赖不能移除 work-item 的健康/身份/隔离检查。旧 computer/task 记录的解码与只读回放继续兼容。 |
| 工程长机械任务 | Codex work-item 内核不强制依赖通用 task API，但外部 full suite/工程验证需要真实 intent、输出、退出、停止与归属。首版保留收窄的工程 task executor，复用 `tools/codex-session-bridge/src/computer/tasks.js`、`tools/codex-session-bridge/src/computer/task-output.js`、`tools/codex-session-bridge/src/computer/execute.ps1` 及 `tools/codex-session-bridge/src/harness/task-source.ts`、`tools/codex-session-bridge/src/harness/task-collector.ts`；不暴露通用 `task_*` 给日常聊天。 |
| 正常路径退出 | `ComputerTools` 的通用文件/shell/Git MCP、通用任务面、旧 Companion 卡片/对话/自动推进、tunnel、公网认证和 Control Center UI 不作为 YER 必需依赖。代码/历史原地保留，本轮不删除、不停服。可选工程 memory store 不等于工作项事实库，ContextAssembler 已允许 null；不把它或 SOUL/USER/MEMORY 一起强迁。 |

当前 `tools/codex-session-bridge/src/main.js` 无条件创建 ComputerTools，将 `computer.tasks` 注入 Harness，shutdown 也直接访问 computer；`tools/codex-session-bridge/src/mcp.js` 混合注册电脑、工程、Companion 等工具。因此后续要分离**装配/注册/关闭路径**，不是原入口传一个空 computer 就会自然工作。`tools/codex-session-bridge/src/harness/runtime.ts` 的 tasks 参数可选，说明 Codex 工程内核可以独立，但旧 task/ComputerCalls 的记录回放、collection failure 与健康门禁不能靠假报 healthy 消失。

工程 task executor 只接显式 Ticket/work item、当前 subject/content identity、获准测试/构建计划及 request ID；将 OwnedTasks 所需的 directory/executable/audit/active-process/closing 小接口从完整 ComputerTools 解耦，保留 pwsh.exe 与进程树停止。无需连带保留 WorkspaceFiles 或通用 query/execute MCP。现有 `companion-mechanical.mjs` 的 fullSuite 确实依赖 computer.tasks 和旧卡片 store：只复用必要执行/证据行为，不把整个 Companion 自动推进器带入 YER。通用文件/Git 修改仍可由 Hermes 完成；工程证据收据不由普通聊天文本代签。

### 3. durable 保证逐项审视

| 保证 | 收缩后如何保持 / 不能夸大的边界 |
| --- | --- |
| 同一职责继续同一 usable session | YER 保留 work item/revision/generation 与服务端 fresh/continue/replace 判断；Hermes chat ID、Main conversation ID、session/run ID 分开，刷新窗口不改变绑定。 |
| 不重复执行 | 保留完整 protected payload 指纹、request→operation/run 索引和先记录后派发；响应未知先查原操作/reconcile，不换 ID 重发。没有宣称任意外部副作用 exactly-once。 |
| Review/finding/Acceptance | 保留 fresh 审查隔离、parent/cycle/issue set、修复等待验证、受审内容身份和真实报告引用；run completed 仍不等于工作项完成、Review passed 或 Acceptance accepted。 |
| 权限冻结/模型路由 | 原生权限在 session 创建时由 YER 解析并冻结；优先省略 permissions。Owner 当前要求 Full Access，实际解析不符须报告冲突，不能静默降权。Sylvia 单独 `gpt-6-astra/xhigh` 写入受信 execution_profile，实际能力不支持即报错，无全局改动/静默 fallback。 |
| 断线与重启 | 只断 HTTP/窗口：已有 run 继续，按 source/cursor 续读。runtime 进程重启：现实现保留历史、拒绝未知活进程归属，未完成 run 可标 interrupted；先 reconcile，再决定同工作项后续 run，不承诺崩溃后原 OS 进程无缝续跑。 |
| 进程/日志关闭 | 保留自有进程树 stop、stopping→真实终态、末尾输出 drain/持久化，所有 owned execution source 停止确认后才释放 writer。不能只关 HTTP 就宣布执行停止。 |
| diff 与内容适用性 | YER 独立重读绑定 worktree 的 HEAD/index/worktree/untracked 与证据哈希；Hermes 原生编辑也能使旧内容身份/Review 证据过期，UI 摘要不能放行旧 patch。 |
| 机械任务证据 | 普通 Hermes 工具事件留在 Hermes，**不会自动成为 YER durable journal**。作为验收证据时须提供可定位原始输出、退出码、内容身份和收据供 YER 校验；不能只用助手“测试通过”文本。工程长任务先保留上述窄 executor，Hermes 等价能力未验收前不替换。 |

OwnedTasks 现有 requests/records 是进程内 Map，task ID 带 service_epoch，有过期语义；durable 的是 journal 中已采集的事实，不能升级为跨重启任意任务恢复。YER 为工程任务在既有 journal 记录 intent/request/内容身份与执行归属，再绑定实际 task receipt；epoch 失效、记录缺口或未知副作用须返回 unknown/reconcile，不自动再跑。替换成 Hermes 原生长任务必须先证明同等证据/恢复能力，是未来替换条件，不是本轮默认前提。

本轮只确定边界。将来切换已有 runtime 前核对源进程、锁、journal schema/source ID、历史绑定与活跃/unknown 操作；一个 runtime 目录只允许一个 writer。旧 YCA 与新 YER 不得同时打开同一 store，也不通过复制私有状态到新目录来假装完成恢复。历史中未结束的旧 general/Companion 工作先在原属运行时协调，不能改名丢弃。首轮验收用独立 fixture/测试 runtime；真实接管另有具体计划和授权，本轮不迁移。

### 4. 本机 transport 与可信控制

**已确认：** Hermes backend→YER 的 IPC 使用数值地址 `127.0.0.1`；YER listener 仅绑定 loopback，Streamable HTTP 位于 `/mcp`。工程状态/控制的 HTTP 与 MCP 共用同一个 runtime owner；不通过公网域名、tunnel、反向代理或 stdio 再启动一个 manager。Codex/模型或 GitHub 自身需要的外网另属业务连接，“IPC 不需网络代理”不等于模型可离线运行。

**Proposal：** 配置只记录本机 endpoint 与预期 runtime 身份引用；启动/重连核对服务能力、runtime/source identity 和协议版本。端口变化须刷新配置及连接，端口占用/身份不匹配直接报错，不尝试别的服务。Hermes SDK / 插件 HTTP 客户端必须实际直连 loopback，禁止 YER 接入跟随到非该 endpoint 的重定向，也不回退公网 URL。该限制放在 YER adapter 的本地 client/transport；若原生 MCP 配置不提供限制入口，用插件的同协议客户端封装，不改全局网络默认。无需修改全局代理设置或依赖用户手工设置 NO_PROXY。

本次源码依据：`tools/codex-session-bridge/src/main.js` 已 `listen(port, '127.0.0.1')`；`tools/codex-session-bridge/src/http.js` 有 Host/Origin 校验、请求大小限制、无状态 MCP transport，断开连接只关闭该 transport。Hermes `tools/mcp_tool_transport.py` 的 `_mcp_proxy_mounts` 在 `is_loopback_host(host)` 时不装代理，HTTP client 使用显式 transport；这是比文档“支持代理/NO_PROXY”更具体的现有直连依据。该文件仍有 `follow_redirects=True`，所以仅填 localhost 不能当作完整的无公网保证；YER adapter 要收窄 redirect 行为并实际验收，不能声称已接通。

受信确认沿用上一版的必要边界：Emilia/Skill 可提出计划，只有宿主受信用户动作或已存在的有效 authority 能赋予执行授权。新授权时 preview 绑定职责、Ticket/worktree、subject/content、范围/终点、profile、权限来源及 payload digest；确认 handler 核 revision/digest 并将最少授权事实写入**同一** execution journal，向 launcher 提供 authority snapshot。已有授权范围内不重复弹窗。模型的 `confirmed=true`、`_meta` 或角色名不产生授权。

插件的确认 backend 走新增 YER `POST /engineering/preview`、`POST /engineering/confirm` 专用通道；不暴露为模型能制造授权的 MCP 工具。沿用受信本机 adapter 身份引用、宿主鉴权/origin/CSRF，不因来自 loopback 就信任。身份配置不进入模型参数/日志；本轮不读取凭据或安装配置。若实现发现需另造长期安全协议，依 #178 策略记录 blocker/follow-up，不能扩大成自研隔离系统。Full Access 与业务授权仍分离。

### 5. 工程接口与投影契约

**Proposal：** Hermes 通过精简的 YER MCP 工具面消费工程能力；不注册通用 `filesystem_*`、`powershell*`、`git_*`、`task_*`，也不保留 raw Codex start/send 作为正常路径。YER 内核使用 Git/文件/进程不等于对外再提供通用电脑工具。

| 面向工程的能力 | 约束 |
| --- | --- |
| Ticket 登记、Context Packet / prepare、work-item 查询 | 复用现有 `harness_register_ticket`、`assemble_ticket_context`、`prepare_ticket_resume`、`get_work_item`；名称可以兼容，身份不能由 Issue URL/local alias 冒充 UUID。prepare 是只读建议。 |
| `start_workflow_agent` | 复用 action-specific strict schema；续发传 `{work_item_id, revision}`，服务端决定 session 和 Main/child，不添加调用方自选 fresh/session/destination 绕过字段。 |
| transition/reconcile/stop、模型/status/output 读取 | transition 只消费受信 `decision_ref`；reconcile 不执行替代 run；stop 核当前确切绑定并继续观察至终态。通用 raw 接口留在原独立管理授权路径，不进入 YER 正常工具目录。 |
| 工程机械验证 | 窄 managed action 消费已确认的测试/构建计划、work item 与 content identity，再调用内部 task executor；先记录 intent/receipt，未知先协调，不开放日常 arbitrary-shell/task 入口。 |

以下名称仍是待新增的投影 seam；YER wrapper 复用 Harness 服务，Hermes REST 不另造事实。插件建议命名 `yer-engineering`，后续源码放 `tools/hermes-yer-adapter/`（尚未创建），替代旧版未实施的 `yca-engineering`/`tools/hermes-yca-adapter/` 建议；Ticket/Notes 文件名保持 HERMES-YCA-001 以维持引用。

| 插件 HTTP 前缀 `/api/plugins/yer-engineering` | 对应工程 seam |
| --- | --- |
| `GET /tickets/{ticket_id}` | `get_engineering_snapshot`：Main/child、work item/operation、workflow/evidence、changes、source/observed_at/capabilities/gaps。 |
| `GET /tickets/{ticket_id}/events?conversation_id=&after=&limit=` | `get_engineering_events`：journal 派生的有界分页、source_id、next_cursor、has_more、high_water_cursor。 |
| `GET /tickets/{ticket_id}/patch?file_id=&revision=&mode=` | `get_engineering_patch`：current/cumulative、绑定内容身份、完整性；不接受任意 cwd/ref。 |
| `GET /tickets/{ticket_id}/operations?request_id=` | `get_engineering_operation`：从原 durable request 查询 receipt；不启动执行。 |
| `POST /tickets/{ticket_id}/preview`、`POST /tickets/{ticket_id}/confirm` | 转接上述受信 preview/confirm，不由 renderer 自报 authority/state。 |
| `POST /tickets/{ticket_id}/actions` | 转接授权范围内的 launcher/transition/reconcile/stop 或工程验证 action，返回真实 operation receipt。 |

身份保留 `schema_version/source_id/ticket_id/conversation_id/work_item_id/generation/operation_id/session_id/run_id`、backend_kind 与实际 model/reasoning/permission source；不适用值为 null。Hermes 的引用/缓存按 connection、profile、durable chat/project、source_id、ticket_id 隔离。产品改名不能重写旧事件的 source 标签或遗失其归属。

事件复用 journal 的 event_id/cursor、源时间、观察时间、source_ref、公开 payload 和 redacted/truncated/incomplete/gaps。类别包括公开消息/进度、tool/command、工程 task、run lifecycle、workflow/finding/review/acceptance、changes-invalidated。保留历史 computer/task 记录，新增普通 Hermes 原生活动由 Hermes 自己展示；未采集正文/内部推理不伪造。非 Codex 后端映射同一契约，缺能力用 unsupported/unknown；现有 DSH 窄派发 runner 不等于完整 Repository Engineer。

- journal cursor 与 run-local output cursor 分开；同一 source 按 cursor 排序、event_id 去重，Ticket 过滤后的 cursor 不必连续。
- 初次 snapshot 固定 high water，先补历史再读其后增量；重连续读同一源/原引用。source 改变或 cursor 失效时刷新快照，不新建模型执行。
- 以有界、可取消的 REST 增量读取为完整路径；`ctx.socket` 仅作通知加速，通知不是 durable 事件。多个窗口共享观察、终态降频；不为轮询调用模型。
- 读失败保留快照并标 stale/unknown；错误保留源 code 与 retryable/reconciliation_required。未知执行查询/reconcile，revision/subject 冲突刷新依据，不能用重试新 ID 绕过。

### 6. Hermes 工程面板与 diff

复用上一版已核的 Hermes Desktop Plugin SDK：panes/routes、`ctx.rest/ctx.socket`、query/storage 和 UI kit，包的 backend `dashboard/plugin_api.py` 与 `desktop/plugin.js` 分别启用。工程 pane 显示当前职责/模型/权限来源、默认折叠的公开过程、修改文件/patch、Review child/finding/Acceptance 及报告引用；Emilia 主聊天只放简短回执和入口，不灌入完整日志。插件后端只转接缓存，报告 Artifact 是预览而非状态权威。

普通文件/Git 操作继续用 Hermes Projects、文件浏览和原生 diff；工程 pane 必须从 YER 的显式绑定 worktree 读事实，不能照搬当前前台 cwd。current 为 HEAD→index、index→worktree、untracked；cumulative 为 immutable Ticket fixed point→当前净内容与 commit 列表。保留已有改动/重叠、归属未证明、binary/deleted/protected/过大等状态，不把关联 run 当修改作者。

复用 `Changes.view/patch` 与安全 Git/文件读取，新增 current 模式不改写 Ticket baseline；revision 绑定 mode、基线/HEAD 和 index/worktree 内容，变化返回 stale。Hermes 原生编辑、commit 或其他工具修改均须触发重新观察，不能要求所有修改先经 YER 才能被看到。首版以 SDK 的 Markdown/LogView 显示 unified patch；未找到公共原生 SyntaxDiff/review pane 导出时不私自 import 私有组件，不先 fork core。现有 SDK/source 的能力是源码证据，未代表已实际装载。

Yuki Harness 的历史/诊断 UI 保留 fallback；YER 内核继续复用其数据服务。真实新链路通过后才退出旧 UI 日常路径，不能为了简化依赖删除历史、停旧服务或新开第二个 writer。

### 7. Skills、生命周期与后续实施顺序

插件只保留短工程路由 Skill：读 Ticket/Notes/AGENTS、repo-local 同根 workflow、Context Plan 和真实 runtime 引用，确定性 preflight/prepare，经已有授权调 launcher、读 receipt。工程规则源仍是 `.workflow/skills/engineering-workflow/`；不复制生命周期到 Hermes Skill，不把 SOUL/USER/MEMORY 搬进去。模型线默认单活跃；本次继续同一 Sylvia 设计工作项，`gpt-6-astra/xhigh` 不扩展到其他 Agent/票。设计→实现另有明确授权与 fresh 职责边界，Review/Acceptance child 的隔离不因 destination=main 而取消。

**后续实施计划（本轮均不执行）：**

1. 在现有模块上分离 YER 工程装配/MCP 注册和关闭路径，保留 store/journal/authority/进程/证据依赖，抽出 PathPolicy 与窄工程 task host；保留旧记录解码。先用独立 fixture runtime 验证不加载通用电脑/Companion 服务也能完成工程职责。
2. 补工程 projection/current diff/operation 查询与受信确认 adapter、loopback 专用接入；不为本地 IPC 配 tunnel 或全局代理，不改权限默认。
3. 建 `yer-engineering` 插件的 backend、工程 pane 与短路由 Skill；Hermes 原生操作与 YER 工作项边界明确，普通工具缺能力时如实报缺口，不悄悄把整套 YCA 加回主路径。
4. 获准后在单个隔离试验 Ticket 上验收真实 Hermes→YER→Sylvia，再单独计划现有 runtime 的接管/旧入口退出。完整 DSH、跨机、删除、私密数据迁移、微信/Live2D/语音均不包含。

### 8. Focused acceptance plan 与 Issue 同步差异

#178 的旧 AC1（调用 YCA direct tools）由 Owner refinement 替换；旧 AC9 的真实链路改为 Hermes→YER→Sylvia。其他工程保证保留，并仅增加此次抽取/本地 IPC 直接必要的检查。下表为 canonical 后续验收计划，**没有任何一项在本轮宣称通过**。

| 对应要求 | 必要证据 |
| --- | --- |
| 修订 AC1：普通操作归 Hermes | Hermes 原生文件/shell/Git 操作产生真实结果，未调用 YCA general tools、未新建 Sylvia run；YER 工具目录无通用电脑/task 动作。普通原生工具日志不冒称已入 YER journal。 |
| AC2/AC6：授权与幂等 | 无授权/伪造确认/过期 preview 被拒；一次确认一个 operation，丢失响应按原 request 恢复；unknown 副作用不重发。工程长任务 receipt/epoch 缺失同样不假报通过。 |
| AC3：过程与恢复 | 同一 run 的进度/命令、模型/权限可读，面板关闭/HTTP 断线后续读无重派；源/账号作用域不串线，stop 有真实终态；runtime 重启保持 interrupted/reconcile 边界而非伪造原 run 续跑。 |
| AC4：两种 diff | staged/unstaged/untracked 与累计已提交改动清楚区分；Hermes 原生编辑/commit 后旧 patch/内容证据失效，binary/deleted/protected 正确降级。 |
| AC5/AC7/AC8 | fresh child 隔离、finding 待验证、Acceptance 证据适用；Sylvia profile 与其他默认不混淆；一个非 Codex fixture 复用 DTO。 |
| 修订 AC9/保留 AC10 | 单个试验 Ticket 的真实 Hermes→YER→Sylvia 确认/过程/diff/独立 Review/Acceptance/恢复证据；在通过前保留 Harness 历史与诊断 fallback。 |
| 抽取必需检查 | YER 不实例化完整 ComputerTools/旧 Companion 也能启动、记录、恢复、停止；原 journal fixture（含旧 computer/task 记录）仍可回放；第二 writer/未知进程不被接管，持久化失败不继续派发。 |
| 本地 IPC 必需检查 | 测试进程设不可用 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY、移除 NO_PROXY，服务不使用公网/tunnel 仍能真实 initialize/tools/list/受管查询并返回 receipt；确认连接目标为 127.0.0.1，不接受外部 redirect/错误服务身份。这里只验 IPC，不要求离线模型生成。 |

实现期定向入口：`tools/codex-session-bridge/test/workflow-agent-launcher.test.ts`、`tools/codex-session-bridge/test/work-item-lifecycle.test.ts`、`tools/codex-session-bridge/test/work-item-review.test.ts`、`tools/codex-session-bridge/test/work-item-access.test.ts`、`tools/codex-session-bridge/test/bridge.test.js`、`tools/codex-session-bridge/test/shutdown.test.js`、`tools/codex-session-bridge/test/permissions.test.js`、`tools/codex-session-bridge/test/harness-tasks.test.ts`、`tools/codex-session-bridge/test/harness-changes.test.ts`、`tools/codex-session-bridge/test/harness-patch.test.ts`、`tools/codex-session-bridge/test/http-responsiveness.test.js`。新增插件测试只覆盖上述直接 contract，不扩成额外压力/平台矩阵。

### 9. 未知项与交接停止线

- 已完成源码依赖审视；YER 尚无工程专用入口或已运行服务。插件/模型/权限/全链路只到设计，不能把旧契约测试或本轮文档校验升级为真实验收。
- 实际 YER 端口/runtime 归属/服务版本、受信 adapter 配置、依赖准备与 Hermes 已安装 SDK 均由下一阶段 preflight 刷新。当前源版本变化时重核相应 seam，不能以旧快照替代生产事实。
- 同一设计工作项的 session/run/revision/usage 未随引用提供；checkpoint 保留 null/unknown，不因 Notes 完成就写 runtime completed，不自动新建 generation。
- 无需再选择产品架构；Owner 收缩方向已明确。具体源码拆分、接口低风险命名、轮询间隔、布局交实现按现有约定决定。若去除某个依赖会损坏上述工程保证，保留其最小内部能力并说明，不扩大到通用电脑 Agent。
- #178 正文与 Acceptance Criteria 已按第 8 节和当前架构同步并重新读取确认；只交接设计，不自动 `/implement`、提交、push、部署或触碰旧 runtime。

### Context Plan

- **Core:** `docs/tickets/hermes-yca/001-hermes-yca-adapter.md`、Issue #178 及本 Notes 第 8 节对旧 AC 的明确修订；`AGENTS.md`、`.workflow/skills/engineering-workflow/SKILL.md` 的工作项生命周期/权限、`.workflow/skills/ticket-design/SKILL.md`；本 Notes、当前 worktree `.local/workflow-state/HERMES-YCA-001.md`、fixed point `1b70d076e921915488e5b117a8acc56f5a85e74d`；装配 `tools/codex-session-bridge/src/main.js`、`tools/codex-session-bridge/src/mcp.js`、`tools/codex-session-bridge/src/http.js`，durable 内核 `tools/codex-session-bridge/src/manager.js`、`tools/codex-session-bridge/src/store.js`、`tools/codex-session-bridge/src/harness/runtime.ts`、`tools/codex-session-bridge/src/harness/harness.ts`，gate `tools/codex-session-bridge/src/orchestration/workflow-agent-launcher.ts`、`tools/codex-session-bridge/src/orchestration/execution-operations.ts`；验证 `tools/codex-session-bridge/test/work-item-lifecycle.test.ts`、`tools/codex-session-bridge/test/shutdown.test.js`、`tools/codex-session-bridge/test/harness-changes.test.ts`。
- **Related:** `tools/codex-session-bridge/src/harness/codex-source.ts` 与 `tools/codex-session-bridge/src/computer/paths.js`（隐藏路径保护依赖）；`tools/codex-session-bridge/src/computer/tasks.js`、`tools/codex-session-bridge/src/harness/task-source.ts`、`tools/codex-session-bridge/src/harness/task-collector.ts`、`tools/codex-session-bridge/src/orchestration/companion-mechanical.mjs`（工程机械任务/epoch/旧卡片耦合）；`tools/codex-session-bridge/src/harness/changes-source.ts`、`tools/codex-session-bridge/src/harness/workflow-source.ts`、`tools/codex-session-bridge/src/orchestration/preflight.ts`（独立事实读取）；Hermes checkout 的 `apps/desktop/README.md`、`apps/desktop/AGENTS.md`、`website/docs/developer-guide/desktop-plugin-sdk.md`、`apps/desktop/src/contrib/plugin.ts`、`apps/desktop/src/lib/desktop-git.ts`、`tools/mcp_tool_transport.py`、`website/docs/user-guide/features/mcp.md`（UI/原生工具/直连与 redirect）；Hermes 路径均相对独立仓库根，绝对定位与 Owner 替换评估路径见 checkpoint。
- **Retrieval:** 其他 Ticket、Review/closeout、`.workflow/history`、完整 Memory 与评估中微信/记忆/语音章节保持冷；先按 `ComputerTools`、`OwnedTasks`、`PathPolicy`、`guardDispatch`、`source_id`、`collectionFailure`、`_mcp_proxy_mounts`、`is_loopback_host` 检索片段；大文件按 symbol 读；原 Notes 的设计快照只用于辨认被本轮替代的方向，不与当前方案并列为规范。
- **Expansion triggers:** 去除 general tools 后装配/关闭/健康门禁失效、工程任务 intent/epoch/证据缺口、旧 journal/未知活进程无法协调、权限/模型或内容身份漂移、loopback 被代理/重定向、Hermes SDK/源版本变化时扩读直接相关模块与测试；发现必须新增产品能力、迁库/接管或长期安全协议时报告并按 #178 follow-up 边界处理，不隐式扩范围。

## 设计验证与交接

本地 Notes 是 canonical；Ticket 保存索引与最新 Owner 约束。下一阶段需重新核实动态事实与 Issue 同步状态；得到 implementation 授权后才按生命周期从持久化引用启动不同职责的 fresh implementation。当前设计续发不新建 session，不改全局模型政策。Context Plan 校验及文档字节/范围核对的本次结果见 checkpoint；未执行 implementation、独立 Review 或真实链路 Acceptance。

## Implementation Handoff（2026-10-04）

Owner 已授权从固定点实施 #178，完成最小定向测试、本地 commit 与交接后停止，不执行 Review。完整交接记录在 [Ticket 的 Implementation Handoff](../tickets/hermes-yca/001-hermes-yca-adapter.md#implementation-handoff2026-10-04)，精确 commit、内容摘要和 runtime 引用保存在本 worktree `.local/workflow-state/HERMES-YCA-001.md`。

已实现 `tools/codex-session-bridge/src/engineering/` 的独立装配、journal 绑定授权/验证、loopback IPC 与工程事件/两种 diff 投影，以及 `tools/hermes-yer-adapter/` 的工具 facade、受信 backend、SDK pane 和短路由 Skill。保留原 store/journal/launcher/生命周期，不加载通用 ComputerTools 或 Companion；普通操作由 Hermes 原生工具承担。配置和源码能力边界见 [适配器 README](../../tools/hermes-yer-adapter/README.md)。

YER fixture、implementation Notes-bound dispatch、current/cumulative diff、Python adapter、Desktop SDK SSR/cursor 和既有生命周期定向验证已有结果；旧 shutdown 用例 1 项失败在固定点同处复现。当前只声明候选实现和隔离测试：没有安装/部署、没有真实 Hermes UI 点击或真实模型/Review/Acceptance 验收，没有接管现有 runtime，也没有 push。

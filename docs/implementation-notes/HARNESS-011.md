# HARNESS-011 / GitHub #51 Implementation Notes

## 结论与范围

- 本票原定为 **acceptance-only**，但设计检查发现一个会阻断最终投影的 concrete implementation defect。本轮立即停止在设计/报告层，不启动 implementation session，不修改产品代码。
- 固定起点是 `1451c1316bcf78c5796061c714d156e51ff007ef`。由于该点存在下述 blocker，最终真实链路只能在“基于该 fixed point 且包含已审查 blocker 修复”的 accepted commit 上执行，再把 #46–#50 已通过能力汇合为 V0 验收。
- 若验收中发现产品代码、公开契约或真实运行行为与 Spec 不符，立即停止验收并报告 defect；不得用补文档、模拟结果或临时绕路掩盖。
- 本票完成只能表述为“V0 已实现并完成一次代表性真实链路验收”，不得表述为长期 stable 或日常长期稳定使用。

## 当前 concrete implementation defect（验收 blocker）

- `tools/codex-session-bridge/src/harness/workflow.ts` 的 `WorkflowHistory.summary()` 只把 `mode === 'full'` 的终态 Review 放入 `fullReviews`，`reviewGate` 也只从该集合判断通过；最终 `acceptance.accepted` 必须满足这个 gate。
- Workflow schema 明确允许 `mode='evidence'`，而 #51 在只有 acceptance docs/archive 改动时按 Ticket 约束必须使用 evidence Review。即使 evidence Review、deterministic Acceptance 和 applicability 全部 passed/verified，当前投影仍会返回 `acceptance.accepted=false`，Projects UI 会显示“未确认 accepted”。
- 现有 Workflow tests 覆盖 full/focused Review 的 accepted gate，但未找到 evidence Review 可满足无实现票 Acceptance 的覆盖。
- 用 full Review 代替 evidence Review 会违反 #51 的 Review 范围要求；手工把 status 写成 passed 也无法改变公开投影。二者都不是可接受绕路。
- 因此，下面计划是该 defect 经独立授权修复并完成相应 Review 后的验收计划。当前不得 rollout/刷新 plugin 后继续执行 AC，也不得把这个 blocker 隐藏为 limitation。

## 验收前置条件

### 1. 生产部署与 Harness UI

当前生产 YCA 仍运行 pre-HARNESS-010 release `49fb936451d681449f6d00a70ff048ba393021d6`，且生产 Control Center 配置没有 `yca.harnessPort`。开始真实链路前必须：

1. 通过现有 Control Center / Supervisor 核对当前 ownership、活动任务、running / selected / remote release、YCA / tunnel 健康和工具摘要；所有动态值记录观察时间与 source of truth。
2. 备份生产 Control Center 配置，在运行时探测一个未占用且不与 Control Center、YCA MCP、YCA control port 冲突的 loopback 端口，并配置为 `yca.harnessPort`。
3. blocker 修复已合并后，只通过 Control Center 的 `update-and-restart` 路径把生产 YCA 更新并切换到包含 `1451c13…` 及该修复的确切 accepted commit；不得直接启动第二个生产 YCA、手工接管进程或绕过 activity / ownership 检查。
4. 以 Control Center `/api/status`、YCA status/tool summary、实际进程身份和 `http://127.0.0.1:<harnessPort>/` 的 HTTP 结果共同确认：running release 等于该 accepted commit、YCA/tunnel 健康、Harness UI 可达。缓存的 selected/remote 值不能替代 running/process 事实。

生产配置位于当前项目 worktree 之外，配置写入和受控重启需要 Owner 在执行验收时明确授权。

### 2. ChatGPT 外部入口

AC1 **要求本次 ChatGPT Emilia 对话中直接可调用**以下四个 YCA MCP 工具：

- `harness_register_ticket`
- `harness_attach`
- `harness_record_workflow`
- `harness_associate_child_conversation`

当前对话仍只有旧 18-tool schema，虽然 live YCA 报告 22 tools；因此在生产更新后必须刷新/重装 YCA plugin schema，必要时新开 ChatGPT 对话并从 checkpoint 接续。四个工具没有出现在 ChatGPT callable schema 前，AC1 不可开始，也不可用 PowerShell、curl、raw HTTP、本地 SDK client 或 Harness 内部 API 代替这项外部入口证明。

刷新前先持久化 ticket id 尚未产生时的 checkpoint、fixed point、生产 rollout 事实和下一步，避免 UI/对话刷新导致重复 rollout。plugin schema 刷新本身不得重放任何工程动作。

### 3. Windows 自启边界

HARNESS-010 已完成真实 Windows 注销→登录 Acceptance 5/5，证明 UI 未打开时 Control Center/YCA/Harness 可恢复，历史保持且不会产生模型请求或重放。#51 只复用并核对该证据，不重新安装 startup task、不再做 logout/login 矩阵。

当前生产 startup task absent 应作为部署限制记录：它不推翻 HARNESS-010 的 AC2 证据，但表示当前日常生产配置没有启用登录自启。是否重新安装属于独立运维决定，不是 #51 Acceptance 的前置条件。

## 代表性真实链路

所有 `request_id` 只对完全相同 payload 重用；payload、cwd、revision 或参数变化必须使用新 id。

1. **0-token preflight**
   - 核对 worktree、branch、HEAD/fixed point、依赖、Git 状态、生产 rollout 事实、可调用工具 schema、无活动 run/task 冲突。
   - 将当前 tracked/untracked 状态保存为外部事实；不把后续 Changes 中的关联误写为修改归属证明。
2. **ChatGPT 直接登记 #51**
   - 调用 `harness_register_ticket`，登记 yuki-link / HARNESS-011 / GitHub #51，传入本 worktree 绝对路径和 fixed point `1451c13…`。
   - 保存返回的 `project_id`、`ticket_id`、主 `conversation_id`、recording 状态、event/cursor（若返回）和 comparison baseline；首次应为非 deduplicated，断线恢复时仅以相同 payload 重试。
3. **一个极小主 Conversation Codex run**
   - 通过 `codex_start_session` 启动一条 bounded、只读的真实 Codex run：只核对 HEAD、Git status、Ticket/Notes 引用和“是否存在产品代码改动”，禁止编辑、提交、push 或扩范围。该 run 的存在是本票“真实 Codex session/run”验收对象，不是为无实现票制造假实现。
   - 立即以返回的 `session_id` / `run_id` 调用 `harness_attach` 绑定到 #51 主 Conversation；随后用 `codex_get_status` / `codex_get_output` 观察到真实终态，不因观察超时重启 run。
4. **记录初始 Workflow**
   - 调用 `harness_record_workflow` 写完整 snapshot：phase=`review`，引用 Ticket、Spec、本 Notes、checkpoint、主 run 和真实 Git subject；Review/Acceptance 均保持 pending/not-recorded，不提前宣称通过。
5. **fresh evidence Review（仅在上述 blocker 修复后执行）**
   - 因预期没有产品实现 diff，Review mode 为 `evidence`，不是 full/focused code Review。
   - 启动一条 fresh、只读、bounded Codex reviewer run，只检查：实际 tracked write set 是否仍为验收文档/归档、AC 证据是否足够且适用、是否存在被文档掩盖的 implementation defect。它不得复用主 run session，也不得修改文件。
   - 用 `harness_associate_child_conversation` 将该实际 reviewer `session_id` / `run_id` 关联为 #51 的 review child Conversation（participant=`coordinator`），再记录 revision+1 Workflow snapshot，包含 evidence Review 结果、artifact/runtime refs 与 isolation assessment。
   - reviewer 发现 concrete defect 时停止并报告，不进入 Acceptance，不在本票内顺手修复。
6. **Emilia deterministic Acceptance**
   - Emilia 依据下面 AC matrix 逐项核验；Acceptance actor=`deterministic`，`execution_refs=[]`，不得创建虚构 Acceptance Agent child Conversation。主 run、review run、release/config 等只作为 `runtime_refs` / `evidence_refs`。
   - 每项 AC 都有可定位的当前事实或已接受 archive 引用后，调用 `harness_record_workflow` 写 phase=`acceptance` 的完整 snapshot。Review 必须适用于同一 subject identity，Acceptance 才可标记 passed。
7. **产品 UI/API 投影核验**
   - 从 Projects 首页进入 #51，核对 Project 分组、recording、Workflow phase/Review/Acceptance、Changes freshness/completeness。
   - 在 Ticket 页核对主 Conversation 的真实消息/run 生命周期、累计 Changes、Workflow evidence、review child Conversation 及 isolation；API `/api/projects`、`/api/tickets/<id>`、`/api/conversations/<id>` 只用于精确佐证 UI 展示，不替代 UI。
   - 关闭并重开浏览器 UI 一次，确认相同 ticket/conversation/source history 仍可读且没有新模型请求。后台重启、Windows 登录、恢复矩阵不重跑。

## AC matrix 与复用边界

| AC | #51 必须新增的真实证据 | 可复用证据 | 明确不重做 |
| --- | --- | --- | --- |
| AC1 外部登记并追踪完整链路 | ChatGPT 直接调用四个 Harness MCP 工具；#51 主 run、fresh evidence Review child、Workflow revisions、deterministic Acceptance；Projects/Ticket/Conversation/Changes/Workflow UI/API 投影 | #46 的 child Conversation / deterministic Acceptance 语义；#47 的累计 Changes 语义 | 不以 curl/PowerShell/raw HTTP 登记；不造假 session/run/evidence |
| AC2 UI/自启/历史/恢复 | 当前生产 UI 关闭→重开一次，确认 #51 历史仍在且无新 run | #50 真实 logout→login 5/5；#46–#49 的持久投影结论 | 不重装 startup、不再 logout/login、不重跑恢复矩阵 |
| AC3 recording failure | 下述隔离真实 runtime 实验：新副作用拒绝、只读可用、已有 task/run 可管理、恢复不重放 | #48 recording-failed manage-existing；#50 recovery observation；既有公开 gate 定向测试作补充 | 不破坏生产 journal，不把禁用按钮或纯 mock 当系统门禁证明 |
| AC4 单一服务 ownership/version | 当前 Control Center `/api/status`、实际 process/deployment commit、running/selected/remote、工具摘要与 Harness 导航/UI 的同一时刻对照 | #49 唯一 Supervisor、activity/release/update/recovery 语义 | 不从 Harness 新建 Supervisor，不复制服务 POST，不绕过 Control Center |
| AC5 Spec/限制/退出 | 对 Spec Testing Decisions 1–9 和 secondary seams 做逐项 pass/limit 表；记录当前 schema、startup、单次验收等限制 | #46 Review/Acceptance、#47 Changes、#48 controls/gate、#49 services、#50 startup/recovery 的 accepted archives | 不把模拟测试、run completed 或 UI healthy 单独写成 Acceptance/stable |

复用 archive 仅取 `.workflow/history/HARNESS-006.md` 至 `HARNESS-010.md` 的摘要/acceptance 段；若引用适用性不足，先报告证据缺口，不扩读旧 raw logs 或完整 Review。

## AC3：隔离 recording-failure 实验

该实验必须是真实进程、真实临时 runtime、真实 StreamableHTTP MCP 边界和真实文件效果；允许使用本地 MCP client，因为它验证的是 AC3 secondary seam。它**不能**替代 AC1 的 ChatGPT-visible 外部登记证明。

1. 在项目 allowlist 内创建唯一临时目录和独立 loopback ports，启动包含 blocker 修复的 accepted commit 的隔离 YCA/Harness；不接 production tunnel，不读取或复制生产 credential，不使用生产 runtime/config/journal。
2. 经隔离 YCA 的真实 MCP client 登记一个明确标为 acceptance fixture 的临时 Ticket，并启动一个可安全停止、没有外部副作用的 owned task；保存 task id、service epoch、journal cursor 和受控 sentinel 路径“不存在”的哈希/状态。
3. 精确定位隔离 runtime 的 `harness/history.jsonl`，先改名保存，再在原文件路径创建同名目录，使下一次 append 真实失败并把该隔离 writer 冻结为 `JOURNAL_WRITE_FAILED`。不得对生产路径做同类操作。
4. 经同一 MCP 公共入口验证：
   - `filesystem_write`（或等价最小 new-side-effect）返回 `RECORDING_FAILED`，action 未执行，sentinel 仍不存在；
   - `task_status` / `task_output` 及至少一个 filesystem/git 只读调用仍成功并携带 evidence gap；
   - 已有 task 没有被 recording failure 自动强杀；显式 `task_stop` 可请求处置，并轮询到真实 terminal，而不是把 stopping 当 stopped；
   - Harness/UI 显示 recording-failed，已保存历史仍可读，cursor 不伪增。
5. 停止隔离进程，删除同名空目录并原位恢复保存的 journal，再重启同一隔离 runtime；核对 recording 恢复、既有 task/run 外部事实和 evidence gap，sentinel 仍不存在、被拒 request 没有自动重放、没有新增模型请求。只有使用新 request_id 的新显式动作才可能执行，本票无需执行它。
6. 完成取证后停止隔离 runtime；仅在解析并确认临时路径位于预定 acceptance 目录内后清理。证据摘要可保留，生产 runtime/journal/config 不动。

既有 `harness-execution-gate.test.ts`、`harness-controls.test.ts` 和 `harness-tasks.test.ts` 可作为契约回归补充，但不能单独替代上述隔离真实进程实验。

## 服务 ownership 与版本核对

- 唯一管理者始终是 Control Center / Supervisor。Harness 只严格校验并导航到同源 `/harness/services`，不代理管理 POST、不持有第二套 desired state/ownership/release 状态。
- 同一观察窗口记录并比较：Control Center supervisor identity/config id、YCA/tunnel process identity、activity、running/selected/remote release、restartRequired、工具定义摘要、Harness services navigation 可达性。
- running release 与实际进程/deployment commit 是“正在运行什么”的事实；selected 是下次启动目标；remote 允许 stale/unknown。三者不得混写。
- Harness 页只需证明导航/投影与上述事实一致。需要 update/restart 时仅在 Control Center 页面执行，并保存 operation receipt；Harness 页面本身不得成为第二管理入口。

## 回滚与安全边界

- rollout 前保存配置备份、旧 running/selected release、process identity、activity 和端口状态。存在活动任务或状态未知时由 Control Center 拒绝或要求本次明确确认，不强停。
- rollout 失败使用 Control Center 既有有限回退；不手工 kill、不删除 runtime/history、不改 tunnel credential。
- pre-HARNESS-010 YCA 不认识 `--harness-port`。若必须回退到 `49fb936…`，应先恢复不含 `harnessPort` 的配置备份，再由 Control Center 启动旧 release；否则会重现已知 startup timeout。
- plugin 刷新可能要求新对话，刷新前先保存 checkpoint；刷新后先只读核对 schema 与生产状态，再登记 #51，避免重复副作用。
- 隔离 failure fixture 与生产路径、ports、process、journal 完全分离；任何目标路径或进程身份不确定时停止，不清理、不强杀。

## 预期写入集合与 Review

- 设计阶段 tracked write：仅 `docs/implementation-notes/HARNESS-011.md`。
- 验收/closeout 预期 tracked write：本 Notes 的事实性收尾更新，以及现有工作流约定要求的 HARNESS-011 Markdown acceptance/closeout archive；不应包含产品源代码、测试代码、配置模板或依赖变化。`.local/workflow-state/HARNESS-011*.md` 仅为本机 checkpoint/evidence，不作为产品实现 diff。
- Primary Review mode：`evidence`。fresh reviewer 只审实际 Markdown subject、外部证据适用性与 AC 覆盖。若 tracked write set 超出上述范围或发现 implementation defect，Review/Acceptance 立即停止并重新定界。
- 当前已发现的 accepted-gate defect 不属于上述 docs-only subject，必须先单独获得实现授权并形成自己的代码/测试/Review subject；不得混入 evidence Review 或用 #51 验收文档淡化。

## V0 退出声明与限制

全部 AC 通过后采用以下口径：

> Yuki Harness V0 的代码已实现，并在基于 fixed point `1451c13…` 的 accepted commit `<commit>` 上完成一条 #51 代表性 ChatGPT Emilia → YCA → Codex → Workflow → Review / Acceptance → Changes/UI 真实链路验收。该结论证明本次受控场景通过，不代表长期 stable。

同时保留限制：

- ChatGPT plugin/tool schema 在服务能力变化后可能不会 hot-refresh；本次若仍复现，记录为客户端集成限制，后续能力升级需刷新/重装或新对话。
- 当前生产 startup task 未安装；HARNESS-010 已证明真实登录恢复能力，但本次结束时的日常部署不会自动在登录后启动，除非 Owner 另行启用。
- 单票、单机、单次受控链路不覆盖长期运行、负载/并发压力、跨版本漂移矩阵或长期可靠性。
- Changes 表示 fixed baseline 到 current 的累计净事实；run/commit 关联不证明具体修改归属，也不重建未观察到的每次中间编辑。
- 来源未提供、recording/collection gap、截断/脱敏和动态状态 stale/unknown 必须继续显式展示；Event Store 不替代 Git、进程、deployment、Review 和 Acceptance 当前事实。
- Harness 不取代 ChatGPT Emilia、Workflow、Codex/YCA 或 Control Center，也未交付 Brain API、DSH/多 Provider、隐藏推理采集或第二套 Supervisor。

## Deferred details

- 临时端口号、隔离 fixture task 的具体安全命令、证据文件名和截图命名在执行时按实时端口/进程事实确定；不得硬编码可能冲突的动态值。
- production startup 是否重新安装、plugin schema hot-refresh 的产品改进、长期 soak/并发测试和旧 release 可选参数兼容性均为后续运维/产品事项，不扩入 #51。

## Context Plan

- **Core**：`.local/HARNESS-011-ticket.md`、`AGENTS.md`、本 Notes、`.local/workflow-state/HARNESS-011.md`、`docs/specs/yuki-harness-v0.md` 的最终链路/Testing Decisions/限制段；`tools/codex-session-bridge/src/mcp.js` 四个 record-only 工具和统一 gate；`tools/codex-session-bridge/src/harness/{server,harness,workflow,conversations,changes,controls}.ts` 的直接 seam；Control Center services/status ownership seam。
- **Related**：`.workflow/history/HARNESS-006.md`–`HARNESS-010.md` 仅摘要/acceptance；`harness-execution-gate.test.ts`、`harness-controls.test.ts`、`harness-tasks.test.ts` 仅作 AC3 契约补充；生产 Control Center `/api/status` 与实际进程/deployment 是动态 source of truth。
- **Retrieval**：需要精确 payload 时读取 `harness/model.ts`、`workflow-model.ts`、`conversation-model.ts`；需要 rollout 参数时读取 `tools/control-center/src/{config,units}.js` 与 bridge `src/main.js`。不读 global/personal Memory、旧 raw logs、完整旧 Review 或完整 Git history。
- **Expansion triggers**：四个 Harness 工具刷新后仍不可调用；production running commit/22-tool summary/Harness UI 不一致；隔离 MCP 无法真实触发 recording failure；UI/API 与 Git/runtime/Workflow 事实不一致；tracked write 超出 Markdown；任何 concrete implementation defect。触发后停止 Acceptance 并报告，不自行扩大实现。

## Readiness

- **设计状态：not ready for acceptance execution。** 已有完整验收计划，但 `evidence` Review 无法产生 `accepted=true` 的公开投影，是 concrete implementation blocker。
- **当前环境状态：not ready。** blocker 修复之后仍需：生产 YCA rollout 到含修复且至少包含 `1451c13…` 的已合并 commit、生产配置 `harnessPort`，以及 ChatGPT 22-tool schema 刷新。
- **Owner action**：先决定是否授权对上述 accepted-gate defect 做最小实现修复。修复合并后，再批准生产配置备份/`harnessPort` 写入与 Control Center 受控 update-and-restart，并完成或授权 YCA plugin schema 刷新/重装。Windows startup 重装不是本票所需动作。

## Blocker Fix Handoff

- **来源与身份**：仅修 GitHub #51 已确认的 accepted-gate blocker；worktree `C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-011`，branch `codex/yuki-harness-v0-011`，fixed point `1451c1316bcf78c5796061c714d156e51ff007ef`，implementation start HEAD `96a0a209c832ecdff2b91f4304b9374525ed13a8`。
- **实际文件**：`tools/codex-session-bridge/src/harness/workflow.ts`、`tools/codex-session-bridge/test/harness-workflow.test.ts`、本 Notes。未改 schema、Acceptance criteria 或 run-completion 语义。
- **语义**：无 findings 时，当前 subject 可由符合既有 `terminalReview`、`applicability=verified`、subject ref/identity 匹配的 passed `full` 或 `evidence` Review 满足 `reviewGate`；有 findings 时仍只从 `fullReviews` 寻找 origin，并要求关联当前 subject identity 的 passed terminal `focused` verification，`evidence` 不能替代 full origin。
- **红→绿**：新增同一 seam 的最小回归，先确认无 findings evidence case 在旧实现下 `accepted=false`（断言 `false !== true`），修复后该 case 为 true；同测 guard 确认 evidence origin 即使配 focused verification 且 finding 已 verified，仍为 `accepted=false`。
- **测试**：`node --test test/harness-workflow.test.ts` 最终 9/9 passed、exit 0；`npm run typecheck` passed、exit 0；`git diff --check` passed、exit 0（仅报告 Windows LF→CRLF working-copy warning）。
- **Review policy**：`delegated`，接收方为上层 Emilia/YCA；本 session 不启动 Review，状态 pending。
- **Commit / 下一步**：Owner 明确禁止 commit/push/PR，因此当前为未提交实现字节；上层应基于实际 diff 启动 fresh Review，再决定后续 Acceptance，不得把本 handoff 当作 Review 或 Acceptance 通过。

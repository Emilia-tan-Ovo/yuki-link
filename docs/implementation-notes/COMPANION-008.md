# COMPANION-008 — 工程查询、取消控制与断线后接续原工作

来源：[Ticket #133](https://github.com/Emilia-tan-Ovo/yuki-link/issues/133)、[Source Spec #125](https://github.com/Emilia-tan-Ovo/yuki-link/issues/125) ID03–05、ID08，US21/24–28/32/34，AC09/10/14。基线与本轮 HEAD：77bafe809e2f4ae4557796624616af14550c34a2；分支：codex/companion-008-control-resume。

状态：2026-09-29 Astra high / fast 重做的实现设计；**P1 已按 Owner 授权与 #133/#125 既有停止/恢复语义落定**。随后 Owner 授权本 Ticket implementation，代码及最小定向测试结果见文末 Implementation Handoff；Review 和真实验收仍待执行。旧 Sol-medium Notes 仅作参考，保存在本 worktree 的 .local/workflow-state/COMPANION-008.sol-medium-reference.md。以下“继承”来自已确认来源；P1 已确认，低风险命名/布局细节按项目先例实现。

## Implementation Notes

### 1. 基线事实与继承边界

- 继承 #133 全部 AC：取消发言、撤销未发卡和停止工程分别处理；受理不等于停止；未知先核对原执行。仅一条代表性真实运行及少量确定性样例，不要求 production 重启，不实现微信或通用 supervisor。
- 继承本轮 contract：design session 由受管工作项绑定决定，destination=main，Owner native permissions。这不表示产品可以把 Review run 改绑到 Main；控制尊重原 operation 的 destination，不启动 session、换 generation 或改变授权/权限。
- EngineeringCardStore 当前 schema v4 有 immutable confirmation、005 claim、006 preparation、007 continuation/action intent。revoke 与 claim/beginPreparation 使用短 SQLite 事务；已 claim 或已有 preparation 时撤销冲突。producer_state 只说明 DSH 派发，不证明 YCA run。
- CompanionContinuationService.get 返回 initial_operation/initial_run、Workflow/Acceptance/PR 与 next action；后续 action run 没有统一“当前执行”投影。Desktop status 仍优先显示 initial run，可能漏掉实现、Review 或测试。
- advanceOne 在检查 next action 前可能调用 preparation/mirror；后面还会启动模型、测试、commit、push、PR。仅在 UI 或 startModel 检查 stop 标记不足以阻断推进。
- HarnessControls.stopRun(ticketId,runId)/stopTask(ticketId,taskId) 已提供精确停止与 control journal，但不负责 Companion 用户意图去重或阻断下一阶段。保留原 request failure/evidence gap 语义。
- Desktop 重开会 list，但自动 refresh 只看 dispatchId；需补 preparation 路径、选卡刷新及旧 generation 缓存失效。断线只使观察过期，不改变工程状态。

### 2. Confirmed P1 — 停止作用域与模块责任

**唯一待确认的高杠杆决定：**“停止这项工作”先持久化阻断该 confirmed work 后续自动推进的意图，再核实并请求停止其已绑定的运行/任务；重连不解除阻断。本票不新增无损暂停或一键续跑。没有活动 run 时也可阻止已接收工作的后续推进，但不显示“run 已停止”。后续明确继续走既有恢复与授权流程，不能仅删除标记或重发确认。

这避免“停止 design 后自动启动 implementation”。不回滚已经发生的文件、Git 或外部副作用；正在进行且不能精确取消的动作沿原 intent/receipt 核对，显示未知。控制范围是**本卡这次确认关联的工作**，不是整个 Ticket 的历史 run，更不是所有 Main/Review session。

在 YCA orchestration 层新增窄的 CompanionWorkControlService，建议文件 tools/codex-session-bridge/src/orchestration/companion-controls.mjs。它组合 card store、ExecutionOperations、runtime、TaskCollector、HarnessControls 和 Workflow，负责关联、投影与控制意图；不维护第二份 phase、run 状态机或 Acceptance bool。007 继续拥有推进规则，manager 只提供通用执行 seam。

### 3. Confirmed P1 — 查询与控制契约

| 接口 | 输入与责任 |
| --- | --- |
| get_companion_work_status | schema_version=1、card_store_id/card_id/revision；从持久确认与绑定解析，允许尚无 continuation/run 的接收阶段。不会调用 dispatch/prepare/advance/resume/start 或写阶段/授权。保留旧 receipt API 兼容，Desktop 查询归一到该接口。 |
| Desktop engineering-card 的 stop action | 可信 Electron IPC 检查 sender/generation/cardId/expectedRevision/request ID；backend 在 card DB 保存用户意图，再通知 YCA。来源由可信入口填写；renderer/DSH 不提供任意 authority、Ticket、session 或 run。 |
| request_companion_work_stop | locator 加 control_id；只消费已持久化且身份/内容匹配的用户意图。相同请求采用原结果；同 ID 换卡、版本或 payload 返回 conflict。不能仅凭 MCP 参数自行制造用户批准。 |

响应分层：卡片/接收及 preparation；initial operation（历史）；当前关联 operation/run/owned task 集合及各自观察；Workflow revision/assessment；Acceptance；PR delivery；control 请求及目标结果。各动态部分有 source、observed_at、current/unavailable/unknown；保留旧值时明确过期。DSH 回合、run 终态、Ticket 验收不能相互升级。

当前执行从 initial claim/preparation request 与 continuation action request/receipt 出发，用 findByRequest/reconcile、runtime 精确 lookup/status 和 task 的 service_epoch/task_id/request_id 核对；受管 operation 同时核对 work item/generation/destination。不能按最新时间、相同 cwd、Ticket 下全部 binding 或 UI 缓存选一个 run。多条合法关联执行逐条显示；矛盾/无法唯一归属时 unknown，不扩大停止对象。查询不应因设计未完成或 GitHub 不可用而隐藏本机运行事实，单一来源失败不抹掉其他来源。

### 4. Confirmed P1 — 持久化与准入竞态

card DB 做 additive migration（v4→下一版），保存停止意图和精确目标尝试：confirmation identity/digest、可信 action source、control/request ID、请求时间、冻结 binding/action/request 引用、目标摘要、CAS version、attempt/观察回执。以唯一约束/CAS 保证同一卡版本一个生效 stop intent，重复点击/重连采用它。只存控制和证据，不复制工程状态；旧卡无 stop 行保持原行为，不自动接收历史卡。

**受理边界是 stop 意图事务提交，不是 IPC/MCP 发出。** stop 与 action 准入使用同一 store 的短事务规则竞争：stop 先提交则拒绝新 action 准入；action 先获准则其稳定 request/intent 必须纳入停止观察。不能靠内存 busy 或一次读 flag 解决并发。数据库事务不跨网络 await，也不声称 SQLite 与进程启动/外部 API 原子提交。

检查覆盖现有 Companion 副作用入口：005 初始 claim/launch，006 preparation 逐步副作用/设计启动，007 模型启动及 retry、阶段/mirror 写入、owned test task、commit/push/PR。复用原 intent/attempt CAS；在最终副作用前重查 stop，模型接入现有同步 authority/guarded dispatch seam。仅限制有本卡 provenance 的动作，不全局封禁 Harness。

- stop 在最终 guard 前可见：记录明确未派发/被控制阻断，不制造 active run 或永久 reconciliation-required。
- 原准入动作越过最后 guard：可能在 stop 提交后才产生 run/回执。冻结其原 request，沿既有 reconcile 核查；出现确属该工作且可管的 run/task 后精确停止。未核清前保持 unknown，不能因暂时没 run 宣布全部停止。
- stop 后 wake 只做控制 reconciliation/观察，不推进阶段、bootstrap、mirror、新测试、push 或 PR；允许保存已发生的结果及必要恢复证据。补原回执不等于新工程执行。
- 外部动作已发生或结果未知时沿原 intent 读回；不补偿删除、不重试 create，不承诺回滚。

意图先于网络调用持久化。YCA 不可达时显示“停止意图已保存，执行结果未核实”；本机后端也不可用则不能声称已保存。YCA wake 从 store 读 stop，避免依赖一次通知必达。已有 preparation 而无 continuation 的记录也须被控制观察覆盖，不能等新模型启动后才发现停止。

### 5. Confirmed P1 — 精确控制、未知与重连

每个目标调用前冻结 operation/request、work item/generation（适用时）、binding、session/run 或 task/service epoch。仅对验证通过且可管的目标调用既有 HarnessControls；不调用 session-only 的宽泛 stop，不按 Ticket 批量停止。目标变化时观察原对象，不自动停后来出现的无关 run。

请求与观察分开：persisted/requested/request_failed/unknown 描述控制请求；running/stopping/stopped/completed/failed 等来自执行事实。自然 completed 显示“已结束，无需停止”，不改成 stopped。无活动目标且在途尝试全部核清时显示“后续推进已阻止；当前无活动运行”。只有匹配的终态支持“运行已停止”；整项工作停止还要求无未核实派发。control journal 缺口必须保留。

控制 attempt 写入后失联，先按同一 control/target 从 runtime/journal 观察，不因响应丢失重复 stop；明确未尝试才执行第一次停止。确定失败/无法核实则保持原 ID、停止闸门和诚实提示，不自行重开工作。精确停止不需要新模型调用。

重连从 card DB、005/006 binding、007 action slots 和原 prepare/resume evidence 定位。list/选卡/refresh 覆盖 dispatch 与 preparation；按 card revision、连接 generation、查询序号接受响应，旧缓存过期或清除，迟到响应不能覆盖新观察。查询不推动工程；既有 YCA driver 可按原授权继续正常工作，但 UI 重开不能再发 DSH turn、确认、prepare、advance 或 start。stop 生效时 driver 只核对停止。prepare_ticket_resume 是只读建议，不是重新执行许可。

取消当前发言沿用 cancel-model/voice scope；撤销继续由事务判定是否仍未接收；已 claim/preparation 的卡走工程控制。UI 不提供暗示无损暂停的按钮：保存 checkpoint/Notes/操作记录不等于可从中断指令处无损续跑。

### 6. 实现顺序与有界验证

P1 已确认；实现顺序：store migration/控制意图和准入 → 原执行关联与状态投影 → 精确控制及 005/006/007 最终检查/wake → Desktop IPC/session/coordinator/renderer → 定向验证及代表性真实验收。不新建恢复引擎或改全局模型 policy。

最小验证以“入口动作→工程结果与副作用计数”为边界：

1. 查询后续 implementation/Review/task；run completed 与 Acceptance 未通过分别显示，GitHub 不可用仍可查本机执行。查询/重开新增工程派发数为零。
2. cancel-model 仅影响当前发言；撤销与迟到 claim/preparation 竞争只产生合法结果；已接收工作不能当未发卡撤销。
3. 两个 store 连接与受控 async barrier 覆盖 stop-before-admission、stop-during-launch；相同 control 去重、changed payload conflict；无后续模型/机械派发，已准入 run 按原 request 查回并精确停止。补一个 owned task 分支，不展开故障笛卡尔积。
4. 少量 stop 回执丢失、终态不可查、同 session 原 run 结束后已有新 run 的样例：不误报 stopped、不误停、不重派。读回 store 保留 stop；复用 HarnessControls exact-stop/journal 先例。
5. Desktop 重连同一 dispatch/preparation locator；旧 generation/迟到响应失效；明确不支持无损暂停。复用 006 prepare/resume 与 007 reconciliation，不重做整套恢复验收。

直接测试入口：
- tools/companion-desktop/test/engineering-cards.test.mjs
- tools/companion-desktop/test/engineering-coordinator.test.mjs
- tools/companion-desktop/test/renderer.test.mjs
- tools/companion-desktop/test/turn-ipc.test.mjs
- tools/codex-session-bridge/test/companion-continuation.test.ts
- tools/codex-session-bridge/test/companion-preparation.test.ts
- tools/codex-session-bridge/test/orchestration-companion-dispatch.test.ts
- tools/codex-session-bridge/test/harness-controls.test.ts

新增控制契约 fixture 随模块新增；实现者运行相关 Node tests 与必要 typecheck，完整套件由上层确定性执行工具在交接时执行。

真实验收只用一条获授权工作：记录原 card/operation/run，断开桌面观察再重连核对仍是原工作；发停止请求，分开记录受理与真实终态、后续推进是否阻断、额外模型调用与重复派发数。运行自然结束就如实记录，不能冒称验证中断；条件不足保留未验证，不新增真实模型调用/production 重启凑证据。fixture 通过不等于真实验收或日常稳定。

Deferred：DTO/错误码、表名、现有布局内按钮位置、轮询间隔按先例实现。P1 的停止范围、准入与 unknown 语义不能交实现者猜测。解除停止/一键续跑、微信、通知、广泛故障恢复和压力矩阵不在本票。

### Context Plan

- **Core:** [#133 全部 AC](https://github.com/Emilia-tan-Ovo/yuki-link/issues/133)、本 Notes（P1 已确认）、AGENTS.md、.local/workflow-state/COMPANION-008.md、fixed point 77bafe809e2f4ae4557796624616af14550c34a2；代码 tools/companion-desktop/backend/engineering-card-store.mjs、tools/companion-desktop/backend/engineering-coordinator.mjs、tools/companion-desktop/backend/session.mjs、tools/companion-desktop/backend/worker.mjs、tools/companion-desktop/desktop/electron/main.mjs、tools/companion-desktop/desktop/renderer.js、tools/codex-session-bridge/src/orchestration/companion-continuation.mjs、tools/codex-session-bridge/src/harness/controls.ts；测试 tools/companion-desktop/test/engineering-cards.test.mjs、tools/companion-desktop/test/engineering-coordinator.test.mjs、tools/companion-desktop/test/renderer.test.mjs、tools/codex-session-bridge/test/companion-continuation.test.ts、tools/codex-session-bridge/test/harness-controls.test.ts。
- **Related:** [#125 ID03–05/ID08、AC09/10/14](https://github.com/Emilia-tan-Ovo/yuki-link/issues/125) 界定语义；docs/implementation-notes/COMPANION-007.md 的 action slot/自动推进、docs/implementation-notes/COMPANION-006.md 的准备恢复；tools/codex-session-bridge/src/orchestration/companion-dispatch.mjs、tools/codex-session-bridge/src/orchestration/companion-preparation.mjs、tools/codex-session-bridge/src/orchestration/companion-mechanical.mjs、tools/codex-session-bridge/src/orchestration/companion-delivery.mjs 是副作用入口；tools/codex-session-bridge/src/orchestration/execution-operations.ts、tools/codex-session-bridge/src/orchestration/workflow-agent-launcher.ts、tools/codex-session-bridge/src/manager.js 提供绑定/最终 guard；tools/codex-session-bridge/src/mcp.js、tools/companion-desktop/backend/yca-engineering-client.mjs 承载高层接线。拟新增控制模块尚不存在，不作基线事实。
- **Retrieval:** 按 initialOperation/get/advanceOne/wake、claim/beginPreparation/claimContinuationAction/updateContinuationAction、authority/guardDispatch/startGuarded/sendGuarded、findByRequest/reconcile、stopRun/stopTask、fullSuite/deliverPr/prepare_ticket_resume 定位；测试按第 6 节检索。恢复读 .workflow/skills/engineering-workflow/recovery.md，CONTEXT.md 只取领域词义。旧 Sol Notes、历史 Issue/Review/Acceptance、完整大 Spec、全量日志和 Memory 保持冷读。
- **Expansion triggers:** stop 与最终 guard 无可解释准入次序、遗漏已有副作用入口、原 request 无法映射 run/task、同 session 出现无关运行、stop 与终态矛盾、查询推动阶段、动态绑定/权限/外部副作用未知时，扩大到对应契约和少量测试；先 reconcile，不新建工作项/session 回避。产品停止/继续语义改变交 Owner，不扩通用 supervisor。

## Implementation Handoff — 2026-09-29

- 来源：GitHub #133、Source Spec #125、本文件已确认 P1；fixed point `77bafe809e2f4ae4557796624616af14550c34a2`，worktree `C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/companion-008`，分支 `codex/companion-008-control-resume`。最终 commit SHA 见同 worktree `.local/workflow-state/COMPANION-008.md`，该 checkpoint 在 commit 后记录。
- 范围：卡片 SQLite v5 追加持久 stop 意图与精确目标 attempt，claim/preparation/action 准入和关键副作用前检查；YCA 增加只读工程状态与仅消费已持久用户意图的控制工具，从原 request 和绑定查运行/任务并调用精确 Harness stop；Desktop IPC、协调器、状态显示与断线刷新接线。取消发言与未发卡撤销仍走原独立路径。停止不回滚既有副作用，也不提供无损暂停或一键续跑。
- 验证：`npm ci --ignore-scripts --no-audit --no-fund` 在 `tools/companion-desktop` 补齐 lockfile 依赖；`npm run build:ui` 为 Harness 控制样例准备测试 UI；`npm --prefix tools/codex-session-bridge run typecheck`、`npm --prefix tools/companion-desktop run check`、`git diff --check` 均 exit 0。定向 Node 测试覆盖 `companion-controls`、`orchestration-companion-mcp`、`companion-continuation`、`companion-preparation` 的代表样例、`orchestration-companion-dispatch`、`harness-controls`、Desktop `engineering-cards`、`engineering-coordinator`、`renderer`、`turn-ipc`，相关最后执行均通过；早期红灯来自缺少 Desktop lockfile 依赖、未构建 Harness 测试 UI，以及新接口引起的旧样例预期变化，修复后已复跑。未运行两个 package 的完整套件。
- Review policy：`delegated`，接收方为 Ticket Main 上层 workflow；Review 尚未执行，不给 Standards/Spec 通过结论。没有已知 Review finding。
- 验收级别：代码与定向 fixture 已验证；尚未执行 #133 要求的一条已授权真实运行的断线重连与停止验收，因此真实链路、日常稳定性均 pending。未知 stop 回执保持未知；自然完成不宣称被停止。未 push、未开 PR、未部署。
- 下一步：上层核对本提交内容、测试适用性和 checkpoint 后，将 fixed point、此 handoff、#133/#125 交给独立 Review。Review 后再按 Ticket 验收；不从本 implementation session 直接推进。

## Finding Fix Handoff — 2026-09-29

- 来源：GitHub #133、本 Notes、`.local/workflow-state/companion-008-primary-review-1-review.md`；修复基线 `799cdd23921785a86844c0f7a9e0106cd054563e`，分支 `codex/companion-008-control-resume`。修复 commit 的精确 SHA 见本 worktree `.local/workflow-state/COMPANION-008.md`。
- 范围：F1 在 implementation launch authority 的最终检查读取 card stop；F2 将 preparation 在途副作用投影为 unknown；F3 按冻结目标核对 stop attempt、Harness journal、失败与证据缺口，并在 Desktop 显示请求状态；F4 将 full-suite 仅按 owned task 关联且保留 service epoch；F5 停止前核对 operation 的受管 work item、generation 与 session 归属。其余行为未扩展。
- 验证：`node --test test/companion-controls.test.ts test/companion-continuation.test.ts`（在 `tools/codex-session-bridge`，20/20 通过）；`node --test test/renderer.test.mjs`（在 `tools/companion-desktop`，36/36 通过）；bridge `npm run typecheck`、Desktop `npm run check`、`git diff --check` 均 exit 0。最终 journal 匹配逻辑调整后另跑 `node --test test/companion-controls.test.ts`，5/5 通过。preparation 测试 fixture 首次缺完整授权结构而失败，修正 fixture 后通过。未运行两包完整测试套件。
- Review policy：delegated，交 Ticket Main workflow 做一次独立 focused re-review；F1–F5 为 fixed、未 verified，原 Standards 无 finding 的结论保留。真实断线重连与停止验收仍 pending；本修复未做真实模型派发、push、PR 或部署。
- 下一步：以修复 commit 与本 handoff 为内容身份复核 F1–F5；复核通过后才进入 #133 的真实链路验收。

## Focused Review 1 Finding Fix Handoff — 2026-09-29

- 来源：`.local/workflow-state/companion-008-focused-review-1-review.md`，受审 HEAD `97aeca8112c7f2834c6e7f3ba937126c75d96afc`。F1、F2、F4、F5 已由该复核验证；本轮只续修原 F3-stop-journal。新 commit SHA 见 `.local/workflow-state/COMPANION-008.md`。
- 修复：从已验证的 owned-task binding 取 `binding_id`，冻结到停止目标，使该目标与 Harness task-stop journal 的身份字段一致；原 journal/result/gap 投影逻辑沿用。
- 验证：`node --test test/companion-controls.test.ts`（在 `tools/codex-session-bridge`）6/6 通过，新增样例覆盖任务目标冻结、正常 task-stop journal 和丢失回执后按原目标查回。最终 typecheck 和 diff 检查结果见 checkpoint。本轮不重跑已验证的其他 finding 测试或完整套件。
- Review policy：delegated，F3 为 fixed、待独立定向复核；其余四项保持上一轮 verified 结论。#133 真实链路验收仍 pending；未 push、未开 PR、未部署。

# ORCH-002 / #91 — Implementation Notes

状态：已确认。Owner 在当前对话确认 P1–P4，并明确授权“写入完成后直接开始 implement”。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/91

Source Spec：https://github.com/Emilia-tan-Ovo/yuki-link/issues/89

设计依据：`.local/workflow-artifacts/ORCH-002/design-proposal.md` 的 Emilia × Sylvia 对齐结果；该调查稿仅按需读取，正式实现决定以本 Notes 与当前 Ticket/Spec 为准。

## Implementation Notes

- **范围与模块边界：** 建立内部显式 durable primitives 与 manager 必要 guarded seam；不交付自动串联 reserve→start→bind 的通用 coordinator，不暴露日常 Agent launcher，不实现 Review/Implementation 业务 launcher。Main/child 共用 operation/receipt/reconcile，child 在 start 前 durable reserve；production init/recovery/query/reserve 与 unknown reconcile 均不调用 start 或 bind。
- **P1 — journal aggregate：** 复用 Harness 单写者 Journal；reserve record 原子保存 operation + typed destination/child reservation，bound composite record 原子保存 operation transition + binding。完整 append 成功后才发布内存索引，重启重放保持相同身份。旧 `attached` / `child_conversation_associated` 继续兼容。必须区分确定未写、完整写入但回执丢失、partial tail；append 异常不得一律视为未接受并释放占用。
- **P2 — identity：** operation request 按 `(ticket_id, request_id)` 查重；operation UUID 派生 Runtime request identity，但仍须 exact lookup/fingerprint 冲突校验且不覆盖。`execution-protected-v1` fingerprint 在 redaction/truncation 前计算，覆盖 expected Workflow revision、subject ref、完整 `yuki-git-subject/v1` scheme/version/scope/completeness/digest、canonical launch identity 与 authorization boundary；durable intent 只保存 prompt digest/长度，不另存提示词原文。先返回原 operation dedupe/conflict，再做首次 dispatch 动态 gates。
- **P3 — dispatch seam：** `SessionManager` 为后续 launcher 提供 guarded path：catalog/permission 异步解析后进入无 await 的同步临界段，最终重查 recording、Workflow revision、完整 subject/content identity、active Runtime/reservation/authorization，先 journal `dispatching`，再持久化 Runtime request 并移除 guarded path 的 `setImmediate` 窗口。不承诺锁住外部 OS 文件修改；公开 `codex_start_session` 行为不变，本票 guard 测试只用 fake executor。
- **P4 — lifecycle / ownership / authorization：** `reserved -> dispatching -> started -> bound`；bound 是归属终态而非 run 终态。active 或 unknown run evidence 继续占用模型线。同 destination active operation 强制互斥；不同 destination 的并发经结构化 authorization validator 校验，V0 默认 single-line。unknown 不冒充 failed，not-found 不自动授权重试或释放 unknown claim。read-only reconcile 只核对 typed operation provenance、Runtime request fingerprint/receipt 与 Harness binding，不改日志、不 start、不 resume、不 bind。legacy/new child 路径共享归属冲突，reserved isolation 为 unknown。
- **只读可见性：** 为 ORCH-001 增加 typed operation projection，使尚未绑定的 intent/reservation 也可被 Context/resume 看见；不伪造 session/run，不因此增加自动恢复执行。

### 实现顺序与验证

1. 建立 typed operation / destination / fingerprint / receipt 契约和 Journal reserve/transition/bound composite 重放；优先验证幂等、payload conflict、Main/child 区分与稳定 reservation identity。
2. 接入 Runtime exact lookup 与 SessionManager guarded acceptance seam；定向验证 post-await recording/revision/content drift 在副作用前拒绝，以及权限冻结、互斥与结构化授权边界。
3. 接入显式 started/bound/failed/reconciliation-required 操作、只读 reconcile 和 Context 投影；通过重启及 failure injection 验证 reservation、state transition、完整写入未回执、partial tail 和 ownership 冲突，不重复启动/绑定或生成矛盾 active operation。
4. Sylvia 只运行直接驱动实现的最小定向测试及必要 typecheck；full suite、Git/GitHub、checkpoint 与 Harness phase recording 由 Emilia + YCA 完成。Review 明确 delegated 给 Emilia 的 fresh reviewer，不在 implementation session 自审。

低风险细节：DTO/helper 命名、文件内拆分和局部测试组织按现有约定决定，不重开架构讨论、不扩大产品范围。

### Context Plan

- **Core：** `AGENTS.md` 当前 guardrails；GitHub #91 最新正文及本 Notes；`.local/workflow-state/ORCH-002.md`；`tools/codex-session-bridge/src/manager.js` 的 replay/start/enqueue/launch 边界；`tools/codex-session-bridge/src/harness/journal.ts`；`tools/codex-session-bridge/src/harness/conversations.ts` 的 apply/associate 边界；直接测试先读 `tools/codex-session-bridge/test/harness-conversations.test.ts` 的幂等/重启/append failure 与 `tools/codex-session-bridge/test/bridge.test.js` 的 restart/persistence cases。Core 是引用和符号地图，不要求整文件复读。
- **Related：** Runtime 接受/lookup 调查时读取 `tools/codex-session-bridge/src/store.js`、`tools/codex-session-bridge/src/permissions.js`；journal schema/replay 调查时读取 `tools/codex-session-bridge/src/harness/model.ts`、`tools/codex-session-bridge/src/harness/harness.ts`、`tools/codex-session-bridge/src/harness/conversation-model.ts`；revision/subject guard 调查时读取 `tools/codex-session-bridge/src/harness/workflow.ts`、`tools/codex-session-bridge/src/harness/workflow-model.ts`、`tools/codex-session-bridge/src/harness/changes-source.ts`；typed Context 投影时读取 `tools/codex-session-bridge/src/orchestration/context-contract.ts`、`tools/codex-session-bridge/src/orchestration/context-assembler.ts`、`tools/codex-session-bridge/src/orchestration/harness-context-source.ts`；内部接线时读取 `tools/codex-session-bridge/src/harness/runtime.ts`。规范歧义时读取 `.local/workflow-artifacts/ORCH-002/issue-89-current.md` 对应章节及 `design-proposal.md` 对应小节，不默认加载完整调查稿。
- **Retrieval：** 使用 git grep / PowerShell Select-String 定位 `REQUEST_CONFLICT`、`WORKFLOW_REVISION_CONFLICT`、`RECORDING_FAILED`、`setImmediate`、`child_conversation_associated`、`currentIdentity`。按故障场景再读 `tools/codex-session-bridge/test/harness-execution-gate.test.ts`、`tools/codex-session-bridge/test/harness-workflow.test.ts`、`tools/codex-session-bridge/test/orchestration-context.test.ts`。新主测试 seam 为 `tools/codex-session-bridge/test/orchestration-execution.test.ts`，尚待实现，不伪装成已有文件。
- **Expansion triggers：** 这是初始检索地图，不是硬白名单。composite bound 与旧投影冲突、post-await guard 无法保持同步、Runtime lookup 归属不完整、typed provenance 缺口或其他影响正确性的事实不明时，扩大最小必要读取；correctness 优先。产品范围不扩入 #92/#93/#94、Provider、UI、deployment/#85 或旧 composite ticket_key 修复。root 未提交父级 Spec/README 不改、不纳入本票。

## Implementation Handoff

- **来源与身份：** ORCH-002 / GitHub #91，source Spec #89，本文件已确认 Implementation Notes；worktree `C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/orch-002`，branch `codex/orch-002-durable-execution`，fixed point 与当前 HEAD 均为 `6e8373d47a8dbc018c421cfc9e4e939eb2560a66`。开始时唯一已有变更为本文件，已保留。
- **实际范围：** 新增 `execution-protected-v1` typed contract 与 Harness Journal operation aggregate；提供显式 reserve/query/dispatch transition/started/bound/failed/reconciliation-required/read-only reconcile primitives。child reservation 与 operation、bound transition 与 binding 分别使用单条原子 record；旧 Main attach / child association replay 保持兼容并与新 reservation 共用归属冲突。Runtime 增加 exact request lookup 与 guarded immediate start seam，公开 start 仍保留原异步行为。Context 增加未绑定 operation 的 typed projection、provenance、unknown side effect 与 reconcile 建议。production 默认 single-line；不同 destination 只有注入的结构化 authorization validator 可放行。
- **安全语义：** protected fingerprint 在 Journal 脱敏前计算，durable intent 只保存 prompt SHA-256 与 UTF-8 长度；post-await guard 最终同步重查 recording、Workflow revision、subject ref、完整 `yuki-git-subject/v1` identity、operation/reservation、Harness binding 与全局 active Runtime 观测。append/receipt 不确定、partial tail、dispatch not-found 或来源矛盾都保守保持 unknown/reconciliation-required，不自动 start、bind、释放 claim 或重放。
- **红→绿与报告：** 初始主测试因缺少 `executionOperations` 为 0/2（退出码 1），见 `.local/workflow-artifacts/ORCH-002/test-orchestration-execution-red.log`。最终 `node --test test/orchestration-execution.test.ts` 为 7/7（退出码 0），见 `test-orchestration-execution-final.log`；`npm run typecheck` 退出码 0，见 `typecheck-final.log`。定向回归：`bridge.test.js` 20/20、`harness-conversations.test.ts` 7/7、`orchestration-context.test.ts` 8/8，报告分别为 `test-bridge.log`、`test-harness-conversations.log`、`test-orchestration-context.log`。conversation 测试前按项目 pretest 运行 `npm run build:ui`，退出码 0，见 `build-ui.log`。
- **限制与未运行项：** 本票未提供 reserve→start→bind 自动 coordinator、launcher 或 MCP capability；未启动真实模型，未运行 full suite、live deployment 或真实端到端验收。guard 只消除当前进程内 await 后陈旧检查与 guarded `setImmediate` 窗口，不宣称锁住外部 OS 文件变化。
- **Review policy：** delegated 给 Emilia；fresh primary Review 尚未执行，Review 与 Acceptance 均为 pending，不声明零 finding 或验收通过。
- **Commit：** 按 Owner 指令未 commit/push/PR；当前仍为工作区实现字节，后续由 Emilia 核对并提交。
- **下一步：** Emilia 以本 handoff、Git diff、上述定向报告和 fixed point 启动 fresh reviewer；Review finding 如有，按 fresh fix session 边界处理。full suite、Git/GitHub、checkpoint、Harness phase recording 与真实链路验收继续由 Emilia + YCA 完成。

### Fix Handoff 01

- **实际范围：** 补齐 IMPL-CHECK-01/02。`reserve` 与 `guardDispatch` 现在对 Harness 可观察的全部 Ticket active/unknown operation 和 binding claim 执行默认 single-line gate；结构化 authorization validator 仍是跨 destination 并发的唯一放行入口。`bind` 在 composite append 前按 session 检查 Main/child 不兼容归属，旧 session-scope 与 run-scope binding 都不能通过更换 run 绕过。
- **正式回归：** `orchestration-execution.test.ts` 增加跨 Ticket reserve、最终 dispatch recheck，以及 session/run 两种 scope 的归属隔离断言。`node --test test/orchestration-execution.test.ts` 先为 7/9、两个新用例失败（退出码 1），修复后为 9/9（退出码 0）；日志为 `.local/workflow-artifacts/ORCH-002/test-orchestration-execution-fix-red.log` 与 `test-orchestration-execution-fix-green.log`。`npm run typecheck` 退出码 0，日志为 `typecheck-fix.log`。
- **剩余事项：** 未运行 full suite，未 commit/push/PR，未更新 checkpoint/Harness。fresh primary Review 与 Acceptance 仍 pending，交由 Emilia 接续。

### Emilia 确定性验证与提交定位

以上 Handoff 是各模型阶段结束时的真实回执，不等同于后续全套测试或独立审查结果。Emilia 的 full-suite 命令、退出码与受测字节记录在 .local/workflow-artifacts/ORCH-002/emilia-verification.json；准确的本地 commit SHA、当前阶段与待办以 .local/workflow-state/ORCH-002.md 为准。Review 与 Acceptance 只能由各自真实报告确认，不从本文件的实现状态推断。

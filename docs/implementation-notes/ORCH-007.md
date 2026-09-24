# ORCH-007 — Unified Workflow Agent Launcher 与阶段策略收口

状态：ticket-design frontier 为空；Owner 已确认统一 typed Workflow Agent launcher 方向，可直接 fresh implementation。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/114
Source Spec：GitHub #89（2026-09-24 Addendum）
Fixed point：`663a174d8d41b99b16ca85bca818918778108f24`
Branch：`codex/orch-007-unified-workflow-agent`

## Implementation Decisions

- **复用，不重建。** 现有 `ExecutionOperations` 继续唯一拥有 durable reservation、request fingerprint/idempotency、single-model-line guard、guarded dispatch、binding 与 restart reconcile；不得建立第二套 workflow execution state。
- **统一 application service。** 新增 `WorkflowAgentLauncher`（命名可按现有风格微调），输入以 typed `action` 区分 `ticket-design | implementation | finding-fix | review | focused-review | acceptance-agent`。公共流程负责 Ticket/Git/Workflow/recording/preflight 校验、fresh start、Owner native permission inheritance、durable reserve/dispatch/bind/reconcile。
- **Phase policy 只描述差异。** 每个 action 的 policy 固定 destination、允许的 Workflow phase、fresh-session 要求、model/reasoning 选择来源、prompt builder、Context/Notes/finding references 和额外 authority gate；不能让 caller 自由拼 destination 或 permissions。
- **权限 contract。** 正常工程 action 的公开输入不接受 sandbox/approval 参数。底层 launch 一律 `permissions: null`，由 YCA 解析并冻结 Owner native default；当前真实 Full Access receipt 应为 `danger-full-access + on-request`。行为上的“只读设计/Review”由 phase prompt/Workflow scope 约束，不通过权限降级制造环境差异。
- **Destination。** ticket-design / implementation / finding-fix → Ticket Main；review / focused-review → typed Review child；acceptance-agent → typed Acceptance child。child relation 必须在模型启动前 durable reservation。
- **阶段语义。** ticket-design 只调查并产出 Implementation Notes/Context Plan，不实现；implementation 固定 delegated Review；finding-fix 只携带原 finding、fix baseline 与窄相关引用；focused-review 只复核原 finding + fix delta；acceptance-agent 只在 AC 明确要求 Agent/session 行为时允许。
- **兼容 wrapper。** `start_ticket_implementation` 与 `start_ticket_review` 的公开外部契约保持兼容，内部委托统一 launcher/共享 service；旧 operation/restart reconcile 兼容必须保留，不能迁移时丢失 durable history。
- **Capability boundary。** 正常 Orchestrator 推荐路径只使用统一高层入口；`codex_start_session`、`harness_attach`、`harness_associate_child_conversation` 保留 compatibility/diagnostic/admin，不作为正常 Workflow 同级选择。若平台层不能物理隐藏，文档与 capability profile 明确降级为 safe recommended path。
- **不扩范围。** discovery/spec/tickets 暂不强制接入 Agent launcher；deterministic Acceptance、PR、closeout、deployment composite tools 不进入本票。

## Implementation Sequence

1. 抽取 implementation/review 共享 launch skeleton 与 typed phase contract，保持旧 public schemas 可兼容映射。
2. 扩展 execution protection schema 以表达通用 workflow-agent protection，而不是为每个新 action 复制一版 operation 状态机。
3. 实现 phase registry/policies 与统一 prompt/context builder；优先复用 Context Assembler / existing authority/preflight seams。
4. MCP 注册 `start_workflow_agent`；旧 implementation/review tool 作为 wrapper/adapter。
5. 加 ticket-design、finding-fix、focused-review、acceptance-agent 的定向测试；回归旧 implementation/review contracts 和 restart reconciliation。
6. 做一条真实 ticket-design smoke，核实际 Full Access、fresh session、Main binding 和 duplicate request dedupe。

## Test Seam

- typed action 严格枚举；caller 不能覆盖 destination/permissions/freshness。
- ticket-design receipt 实际 permissions 继承 Owner Full Access；禁止 silent read-only/workspace-write downgrade。
- implementation/review 旧公开输入与 receipt/reconcile 行为保持兼容。
- finding-fix/focused-review 的 prompt/context 不继承旧 implementation 聊天，只带 finding/fix baseline/必要引用。
- review/focused-review/acceptance child 在模型 start 前完成 reservation；Main 不误绑。
- 相同 request + 同 payload dedupe；同 request + 不同 action/payload conflict；service restart 后 reconcile 不创建第二 run。
- single-model-line、recording gate、Workflow revision/content identity drift 继续 fail-closed。
- 不为统一 launcher复制第二套 durable state/journal。

### Context Plan

- **Core:** GitHub #114 AC；本 Notes；`tools/codex-session-bridge/src/orchestration/{implementation-launcher.ts,review-launcher.ts,execution-operations.ts,context-assembler.ts}`；`src/harness/execution-model.ts`；`src/mcp.js`。
- **Related:** GitHub #89 2026-09-24 Addendum；`AGENTS.md` 权限/模型/session 规则；implementation/review launcher tests 与 execution-operation restart/reconcile tests。
- **Retrieval:** 搜索 `startTicketImplementationInputSchema`、`startTicketReviewInputSchema`、`reserve(`、`guardDispatch`、`permission_selection`、child destination/acceptance relation；历史 ORCH-002/003/004 Notes 默认冷读。
- **Expansion triggers:** 若统一 protection 无法兼容既有 v2/v3 durable operations、phase action 需要新的 Conversation relation schema、旧 public wrapper 无法保持 receipt/reconcile 兼容，或 capability hiding 需要平台外改动，先最小化方案并记录限制，不扩大为 Workflow 重写。

## Implementation Handoff（2026-09-24）

- **来源与身份：** GitHub #114、#89 Addendum 与本 Notes；worktree `.local/worktrees/orch-007`，branch `codex/orch-007-unified-workflow-agent`，fixed point / 实现前 HEAD `663a174d8d41b99b16ca85bca818918778108f24`。
- **修改范围：** 新增公开 `start_workflow_agent` typed action、受信任阶段 policy/authorization 与四个新增阶段 gate；implementation/review 原入口经统一 service 兼容映射。现有 `ExecutionOperations` 增加 v4 protected intent，保留 v1–v3 journal 回放；权限输入固定为 `null`，由 YCA 冻结 Owner native default。README 与 MCP 描述标明正常高层路径和仍公开的兼容低层工具。
- **测试：** `npm run typecheck` 退出 0；`node --test test/workflow-agent-launcher.test.ts` 7/7 通过；`node --test test/orchestration-execution.test.ts` 12/12 通过；旧 implementation/review 公开 MCP 定向回归 2/2 通过。测试以真实 Harness/journal、临时 Git 仓库和可控 manager adapter 核对 reservation、Main/child binding、Full Access receipt、重复请求与重启去重。未运行 full suite。
- **已知限制：** 当前 worktree 的新入口尚未部署到正在运行的 YCA；真实 Codex `ticket-design` run 的 Owner native `danger-full-access + on-request`、fresh session、Main attribution 和 duplicate request smoke 仍待上层在单模型线空闲且新服务可用后验收。MCP 仍公开低层入口，故 capability boundary 是 documented safe recommended path。
- **Review policy：** `delegated`；接收方 Ticket Main / fresh primary Review。此 implementation session 未执行 Review，finding 状态未知。
- **Commit：** 实际 SHA 见本 worktree `.local/workflow-state/ORCH-007.md` 的 post-commit checkpoint；本 handoff 随实现提交。
- **下一步：** 从 fixed point 与本 handoff 对提交内容做 fresh Review；真实 ticket-design smoke 列为尚未验证的 Ticket AC，由上层安排，勿将本次 fixture 测试提升为真实验收。

## Finding Fix Implementation Handoff（2026-09-24）

- **来源与身份：** GitHub #114、#89 Addendum、上方 Implementation Decisions、`.local/workflow-state/ORCH-007-review.md`；修复基线 `323c5d41f4ee09e6188ff77311f35286ae792fa6`，当前 worktree/branch 沿用上方身份。
- **修复范围：** ORCH007-STD-001：README 说明 `references/current_delta` 的阶段必填及 finding 阶段禁传契约。ORCH007-SPEC-001：focused Review 必须与当前 subject ref 和 identity 一致。ORCH007-SPEC-002：finding-fix/focused-review 公开输入拒绝 caller 的 `references/current_delta`；从受信任 authorization 的 finding/report/context refs 与 Workflow 当前 subject 生成窄上下文和 fix delta。ORCH007-SPEC-003：acceptance-agent 需绑定受信任 authorization 的具体 `agent_criterion`，并核对 Workflow Acceptance 中有同一 `criteria_ref`。未修改 Review 报告中的非阻断重复代码意见。
- **测试：** `npm run typecheck` 退出 0；`node --test test/workflow-agent-launcher.test.ts` 10/10 通过；`git diff --check` 退出 0。测试使用 Harness/journal 和临时 Git 仓库的受控 manager adapter，覆盖上述拒绝 gate 与原有 reservation/dedupe；未运行 full suite 或真实 Codex smoke。
- **Review policy / finding 状态：** delegated，接收方 Ticket Main；四条 finding 已修复待 fresh focused re-review 核验，未自行执行 Review。真实 ticket-design smoke 仍属待验收项。
- **Commit：** 本修复的实际 SHA 见当前 worktree `.local/workflow-state/ORCH-007.md` 的 post-commit checkpoint；本 handoff 随修复提交。
- **下一步：** 上层以原 primary Review 报告、修复基线、本修复 commit/diff 及定向测试为输入，启动 fresh focused re-review；本次 fix session 在 handoff/commit 后停止。

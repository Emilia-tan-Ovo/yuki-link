# ORCH-003 / #93 — Implementation Notes

状态：设计已确认；仅交接给后续 fresh implementation session，本文件不授权在 ticket-design session 内开始实现。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/93
Source Spec：https://github.com/Emilia-tan-Ovo/yuki-link/issues/89
固定点：`b4d48564c6d1798dfe82f6c3822fb6d9a556adde`；branch `codex/orch-003-fresh-review-launcher`。

## Implementation Notes

- **入口与归属：**公开 `start_ticket_review`，固定 fresh reviewer 与 typed Review child destination。V0 正常路径使用一个 `coordinator` reviewer；destination 从 Ticket Main 与 `{ kind: 'review', review_id, participant: 'coordinator' }` 预留，caller 不能传既有 session/thread、Main destination、任意 cwd、权限或完整 prompt。Review 两轴默认由同一 fresh reviewer 串行完成；focused re-review 专用 launcher 不在本票。
- **可信 authority：**Owner 已批准沿用 ORCH-004 模式，在 Orchestration application layer 增加最小 Review 专属、可信激活、版本化 policy/authorization snapshot。授权必须绑定准确的 Ticket、`review_id`、Review action、subject/contract identity；`authorization_ref` 只用于查找，不能自行证明授权。policy 仅决定本入口的 model/reasoning、适用范围、权限选择及必要 preflight，不扩为通用 policy engine，也不重构 Implementation launcher。策略缺失、失效、版本不兼容或授权无法核实时 fail-closed；使用 Owner 原生权限解析并冻结实际快照，不硬编码旧模型路由或权限值。
- **public input 与前置条件：**最小版本化输入为 `ticket_id`、`request_id`、`review_id`、必要 `authorization_ref`、`expected`（Workflow revision、Review subject/ref 与完整 `yuki-git-subject/v1` content identity、Review policy identity/digest）及有界的引用/current delta。expected 只用于 compare-and-reject；从 Ticket registration、Workflow、Git/ChangesSource 与可信 authority 重读当前事实。Review identity 包含目标 review/subject 与适用的 contract，不仅依赖 HEAD；不完整 Git identity、recording 不健康、revision/subject/authorization 漂移或模型线冲突均在模型副作用前拒绝，并在 post-await guarded dispatch 再检查。
- **durable identity：**复用 ORCH-002 的 `(ticket_id, request_id)` 幂等键、operation UUID 派生 Runtime request id、typed child reservation、Journal 原子记录与 exact Runtime lookup。为 Review 增加带类型/版本的 protected snapshot 和 caller fingerprint；caller fingerprint 只覆盖稳定 public payload，protected fingerprint 冻结 contract、authority、destination、Workflow/Git identity 与 launch/prompt digest。保留旧 v1/v2 operation 的 replay/reconcile，不给旧记录补造 Review 事实。先查已接受 request，再做首次新副作用的动态 preflight：同 payload 只读返回原 operation，不同 payload 报 `REQUEST_CONFLICT`；policy/source 暂时不可用也不阻断已接受 request 的只读恢复。
- **执行序列：**新请求经可信 authority 与 recording/Ticket/Workflow/Git/model-line preflight 后，先 `reserve` 并确认 Review child relation durable，再用 `SessionManager.startGuarded()` 创建全新 session/run；凭原 Runtime request 的精确回执 `markStarted`，最后仅 `bind` 到预留 child。MCP 外层不能用首次启动的 recording gate 误挡已接受 request 的只读 reconcile。实际 session 不得有 Main 或不兼容 child binding；receipt/Harness 查询须显示 relation、binding 与隔离证据，证据不足保持 `unknown`，不伪称 verified。
- **unknown / restart：**reserve/start/started/bind/Journal 回执未知时保留原 operation claim，先核对 Journal 与 exact Runtime request/binding；partial tail、not-found 或来源矛盾不当成安全重试许可。reconcile 保持只读，不自动 start/resume/bind，也不创建第二个 reviewer。完整 append 后丢回执可在重启回放恢复；无法确认的状态保留 `reconciliation-required`。统一 receipt 至少关联 operation/request、fingerprint、state/effective state、session/run、typed child/parent Conversation、binding、实际权限、recording 与 reconciliation。
- **范围边界：**#93 仅保证同一 operation/request identity 的至多一次启动与一个对应 child Conversation。不同 request id 重启同一已完成 focused Review 的跨请求去重是明确 follow-up；不在本票新增 one-shot 门禁。capability profile、Implementation launcher、Memory、通用 workflow transition/query、Provider abstraction、最终真实协作链验收与 YCA/Control Center runtime 稳定性均不在本票。

### 实现顺序与验证

1. 扩展 Review 专属 typed contract、durable protected snapshot/receipt 与可信 authority seam，保留旧 Journal 回放。
2. 接入薄的 Review launcher 和 public MCP，按 existing-request-first → preflight → durable reserve → fresh guarded start → started → child bind/reconcile 编排；prompt 只引用必要证据与当前 delta。
3. 用公开 `start_ticket_review` MCP/API、真实 Harness/Journal 和可控 manager adapter 做定向测试：pre-start reservation；fresh session 且无 Main binding；child relation/binding/isolation 可查询；recording、revision、content、授权漂移在副作用前拒绝；same-request retry/payload conflict；reserve/start/bind/append unknown 的重启 reconcile 最终至多一个 session/run 和 child Conversation。测试外部事实，不以内部 helper 调用次数替代验收。
4. 实现模型只运行驱动红→绿的最小定向测试和必要 typecheck；full suite、Git/GitHub、checkpoint、Harness 记录及后续 Review/Acceptance 由 Emilia + YCA 按既有边界完成。

低风险 deferred details：DTO/helper 命名、Review protected schema 的具体版本标签、fixture 文件组织及局部错误码可按现有约定在实现中决定；不得借此扩入 focused re-review 跨请求去重。

### Context Plan

- **Core:** GitHub #93 最新正文、本 Notes、根 `AGENTS.md`、`.local/workflow-state/ORCH-003.md`；`tools/codex-session-bridge/src/orchestration/execution-operations.ts`、`tools/codex-session-bridge/src/harness/execution-model.ts`、`tools/codex-session-bridge/src/orchestration/implementation-launcher.ts`、`tools/codex-session-bridge/src/mcp.js`；直接测试入口 `tools/codex-session-bridge/test/orchestration-execution.test.ts`、`tools/codex-session-bridge/test/implementation-launcher.test.ts`，新增 public Review launcher test。
- **Related:** GitHub #89 的 Enforced Rules / high-level API / Testing Decisions；`docs/implementation-notes/ORCH-002.md` 与 `docs/implementation-notes/ORCH-004.md`；按需读取 `tools/codex-session-bridge/src/manager.js`、`tools/codex-session-bridge/src/harness/conversation-model.ts`、`tools/codex-session-bridge/src/harness/conversations.ts`、`tools/codex-session-bridge/src/harness/workflow-model.ts` 及 `tools/codex-session-bridge/test/harness-conversations.test.ts`。
- **Retrieval:** 定向查找 `startGuarded`、`findByRequest`、`reserve`、`guardDispatch`、`markStarted`、`bind`、`reconcile`、`childRelationSchema`、`subjectIdentity`、`gateHarnessExecution`、`RECORDING_OUTCOME_UNKNOWN`。不默认加载无关历史或大日志。
- **Expansion triggers:** Review subject/授权无法由现有权威来源精确比对、post-await guard 无法复验、fresh/isolation 证据不能从 Harness 查询、旧 Journal 兼容性或 public unknown recovery 存在歧义时，扩大最小必要调查；不扩大产品范围。

## Design Handoff

- Owner 已确认上述 Review 专属可信版本化 authority 方案和本票边界。GitHub #93 未修改；本地 Notes 是 fresh implementation 的设计来源。
- 实现必须从本 Notes、Ticket/Spec、checkpoint 与固定点启动新的 model session；本次 ticket-design 到此停止，不调用 implement。

## Implementation Handoff（2026-09-23）

- **来源与身份：**GitHub #93、Source Spec #89、上方 Implementation Notes；worktree `C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/orch-003`，branch `codex/orch-003-fresh-review-launcher`，fixed point 与当前 HEAD 均为 `b4d48564c6d1798dfe82f6c3822fb6d9a556adde`。本轮实现尚未提交；上述设计 Notes 原本就是未跟踪文件，已在本节追加交接。
- **实现范围：**新增公开 `start_ticket_review`、Review 专属版本化可信 authority 文件入口和 protected operation v3。首次请求先核对 recording、Ticket/Workflow/Review subject、完整 Git content identity、授权与模型线，再 durable reserve Review child，随后 guarded fresh session/run、mark started、仅 bind 预留 child。同 request 先查已接受 operation 并只读 reconcile；changed payload 冲突。Harness 的 child binding 保存可查询的实际隔离评估；证据不足保持 `unknown`。
- **变更文件：**`tools/codex-session-bridge/src/harness/{conversations.ts,execution-model.ts,harness.ts}`、`tools/codex-session-bridge/src/orchestration/{execution-operations.ts,review-launcher.ts}`、`tools/codex-session-bridge/src/{main.js,mcp.js}`、`tools/codex-session-bridge/test/review-launcher.test.ts`。新 launcher SHA-256 `9b7ea83e4f59c538e0cb6c9ffb5a74b8316f4bc969d266254d0192957b1d93d4`，新测试 SHA-256 `c7ef8d7f6058650710c6122304d017ea3a89a6853e2758959b9524ced461a506`；其余 tracked diff 以本 worktree 相对上述 HEAD 为准。
- **验证：**在 `tools/codex-session-bridge` 执行 `node --test test/review-launcher.test.ts test/orchestration-execution.test.ts test/implementation-launcher.test.ts`，exit 0，29/29 通过；`npm run typecheck`，exit 0；`git diff --check`，exit 0。测试覆盖公开 MCP/API、pre-start child reservation、fresh/child/Main 归属、隔离证据、前置与 post-await 漂移、同 request 与 payload 冲突，以及 reserve/start/started/bind 丢回执后的只读重启 reconcile。
- **Review policy 与状态：**本次由上层接手 fresh Review；implementation session 未执行最终 Review、Acceptance、commit、push、PR、merge、deploy 或 GitHub Issue 写入。Review finding 状态为 pending，不能据本轮测试宣称验收通过。
- **风险与后续：**尚未用真实 Codex/YCA/Harness 生产链路验收；运行实例需要另行可信激活 `--review-launch-authority` 才能接受首次 Review 启动。focused re-review 跨 request one-shot、防绕过的日常 capability profile，以及 Control Center/YCA 的 `--implementation-launch-authority` 部署配置均在本票范围外。
- **下一步：**上层核对当前 worktree diff、未跟踪 Notes/新文件与测试结果，启动独立 fresh primary Review；本 session 到此停止。


## Base Drift Reconciliation（BUGFIX-101 后）

- **基线更新：**ORCH-003 的 immutable ticket fixed point 仍为 `b4d48564c6d1798dfe82f6c3822fb6d9a556adde`；在 primary Review 前，因 BUGFIX-101 / #101 已合并并上线，当前 branch HEAD 已 deterministic fast-forward 到 production release `a3e847e13d5b0d0c1f9a8b0aea641e9fe588a165`。Review/后续合并以该 production HEAD 作为当前集成基线，fixed point 仅保留票据来源追溯。
- **重放结果：**旧 ORCH-003 tracked diff 经 Git autostash 重放到新基线；除 `tools/codex-session-bridge/src/mcp.js` import 区外均自动合并。唯一冲突机械保留 BUGFIX-101 的 `DEFAULT_MODEL/DEFAULT_REASONING` 与 ORCH-003 的 `ReviewLauncher/startTicketReviewInputSchema` 两个独立 import，无产品语义取舍。
- **补充回归：**BUGFIX-101 后原 ORCH-003 / ORCH-002 / ORCH-004 定向组在新基线上为 31/31 pass，`npm run typecheck` pass。Context/preflight/bridge 交叉回归初次 36/37，唯一失败为 `bridge.test.js` 写死公开工具数 13；ORCH-003 新增 `start_ticket_review` 后实际为 14。已将断言更新为 14 并显式检查 `start_ticket_review` 存在，随后 `bridge.test.js` 20/20 pass；同轮 Context/preflight 17/17 已通过。
- **机器契约：**按 BUGFIX-101 新 contract 将 Context Plan 四个 canonical label 规范为 `- **Label:** value`；production validator 返回 `CONTEXT_PLAN_OBSERVED`。最新 `git diff --check` pass。
- **Review 状态：**尚未开始正式 primary Review；下一步必须使用 fresh `gpt-6-sol high` 执行 full Review（Standards → Spec 两轴）。本次 base drift reconciliation 未启动模型，也未重新实现 ORCH-003。

## STD-001 Finding Fix Implementation Handoff（2026-09-23）

- **来源与身份：**#93、上方 Notes、`.local/workflow-state/ORCH-003-review.md` 的 STD-001；fixed point `b4d48564c6d1798dfe82f6c3822fb6d9a556adde`，修复前 integration HEAD `a3e847e13d5b0d0c1f9a8b0aea641e9fe588a165`，分支 `codex/orch-003-fresh-review-launcher`。精确提交 SHA 由提交后的 checkpoint 记录。
- **范围：**Review child 查询从 Runtime session/run/events 刷新隔离评估；结果变化时追加 `child_isolation_assessed` Journal 记录，返回 `assessed_at` 和记录 provenance。Journal 无法持久化变化时返回 `unknown` 且不把旧记录标为当前 provenance。重启时按 Journal 顺序保留最新评估，执行操作重放不再二次覆盖 Conversation。绑定时的 operation receipt 保留原始快照。仅修 STD-001；原 Review Spec 轴结论不变。
- **测试：**`node --test test/review-launcher.test.ts` 7/7 pass；`npm run typecheck` pass；`git diff --check` pass。新增回归覆盖绑定时无 thread、thread 晚到、重启后查询及无变化时避免重复记录。额外尝试 `harness-conversations.test.ts` 时旧组连续失败且未正常结束，未将其计作通过；本修复的定向组已独立通过。
- **Review policy：**delegated，交给 Ticket Main 启动 fresh focused re-review；本 session 不执行 Review。STD-001 为 `fixed-unverified`，Acceptance 尚未执行；真实 Codex/YCA/Harness 链路尚未验收。
- **下一步：**Ticket Main 以本 handoff、原 Review 报告、最新提交与 STD-001 差异启动一次 fresh focused re-review；不重复原 full Review，不扩展 #103/#104 或 production activation。

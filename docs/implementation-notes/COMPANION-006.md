# COMPANION-006 Implementation Notes

Source: GitHub #131 / Source Spec #125 US12, US13, US14, US17, US18, US19, US21, US32 / AC04, AC06, AC08, AC10
Fixed point: `30690d4146ed46b3d58837533c10b88b4c7a6cff`
Canonical implementation-design artifact: this file. GitHub #131 remains the canonical Ticket/product-scope source and mirrors this file for human/tracker visibility; the mirror must carry this file's digest and must not be treated as a second writable source of design truth.

## Implementation Decisions

- **缺号卡不伪造 Ticket。** `explicit_new_requirement` 继续保留 `ticket=null`。Owner confirmation 冻结其实际看见的目标、项目、准备终点、逐项 preparation authorization 与 content digest；任何派生产物都通过 preparation binding 关联，不反写成“原确认本来就包含了这些事实”。COMPANION-005 的“已存在且已核验 Ticket → 可信派发”契约保持原职责。
- **新增版本化、Owner 可见的 preparation authorization contract。** 对无 Ticket 卡至少显式表达：目标项目/需求摘要、准备终点、是否允许创建/关联 GitHub Issue、是否允许创建/采用 branch/worktree，以及明确禁止的后续动作。缺省一律未授权，旧 confirmation 不自动升级。必要的卡片展示、编辑、确认摘要、revision/CAS 与 content digest 接线属于本票；视觉重做仍留在独立 UI Ticket。Endpoint（如 `design-only`）与“允许哪些持久准备副作用”是两个不同维度，不能互相推导。
- **Owner 本轮已确认的默认产品行为：**如果用户要求继续完成工程设计但没有授权建立该设计所需的 Issue/worktree，006 不新增第二条“无 Ticket/worktree 的纯设计 Workflow”；卡片如实停在“缺少具体准备授权/条件”。只有以后 Owner 明确要求支持这条独立设计路径时再另行设计，不由实现者隐式扩范围。
- **YCA 只拥有窄 preparation application service，不拥有第二套 Workflow。** 公共入口以可信 Engineering Card 的 `card_store_id/card_id/revision`（及稳定 preparation identity）为主，由 YCA 回读确认快照；DSH/Desktop/WeChat 不自行拼 cwd、Notes、Workflow、authority 或模型参数。preparation record 只保存确认身份、受保护 payload digest、产物绑定、步骤回执和 unknown side effects；工程 phase 仍只属于 Harness Workflow，模型 reservation/run/binding/reconcile 仍只属于 `ExecutionOperations`。
- **Bootstrap 顺序固定，不能让设计 Agent 创建自己的启动前提：**
  1. 回读并核验 confirmed card revision/content digest 与 preparation authorization；
  2. 在任何不可重复副作用前持久化 stable `preparation_id`、受保护 payload digest 与预期产物槽位；
  3. 仅在授权内创建或关联 canonical GitHub Issue；
  4. 从可信项目配置解析 repository 与允许的 base ref，冻结真实 base commit OID，再确定并持久化 branch/worktree canonical path；
  5. 创建/采用 worktree 后核验 repository identity、registered worktree、branch、HEAD 与 frozen OID；冲突保留现场；
  6. 只有 Git baseline 完整可验证后才调用现有 `harness_register_ticket`，不得先登记一个 baseline gap 再期待原位补齐；
  7. YCA preparation adapter 生成初始 checkpoint 与基于真实事实的完整 Workflow snapshot，并通过现有 `harness_record_workflow` 记录/评估；该 API 只记录调用方提供的完整 snapshot，不被描述为自动生成 checkpoint/authority；
  8. 从 immutable Owner confirmation + verified preparation bindings + active trusted policy 派生仅限 `ticket-design` 的 authority；
  9. 最后才调用统一 `WorkflowAgentLauncher` → `ExecutionOperations` 启动 fresh Sylvia。
- **GitHub Issue 创建使用 durable preparation identity，而不是标题猜测。** GitHub 写入由已认证的 YCA/Emilia deterministic adapter 承担，不允许模型临时拼 `gh issue create` 作为产品路径。副作用前先持久化 `preparation_id`、payload digest、repository identity 与 creation marker；marker 只用于定位，绝不授予权限。成功后绑定 canonical repository + immutable GitHub Issue ID/number/url/scope。若创建回执未知，恢复时只能在来源与 marker/payload 关系均可验证且候选唯一时采用；0 个、多个或来源无法验证都保持 unknown，禁止按标题/普通正文相似度认领，也禁止盲目再建。
- **Worktree/fixed point 是冻结事实。** base ref 来自可信项目配置，首次 preparation 时解析成 commit OID 并持久化；branch/path/repository identity 随 preparation binding 冻结。恢复必须核对 Git worktree registry、canonical path、repository identity、branch、HEAD 与原 `preparation_id`。已有目录/branch 只有在全部身份一致时才可采用；不一致则保留现场并进入 conflict/unknown，不换名再造第二份。
- **设计产物只有一个 machine-authoritative source。** `docs/implementation-notes/<ticket>.md` 是 Workflow launcher/Context 实际消费的 canonical implementation-design artifact；GitHub Ticket body 是 canonical product/ticket scope，并保存该本地文件的镜像与 digest/version 供人类追溯。发布顺序为：先原子写入/回读本地 canonical file → 计算 digest → 更新 GitHub mirror → 回读验证 mirror digest/content；任一步未知或两边不一致都不得进入 design-complete / implementation-ready。镜像更新只能更新已授权的派生设计产物，不能悄悄改变原 confirmed card 的目标、AC、endpoint 或授权；这些发生变化时必须产生新 card revision/confirmation。COMPANION-005 的 scope 校验不得为了双写方便被放宽。
- **Readiness 必须按动作分层。** typed preparation receipt 至少分别表达：
  - `preparation_for_ticket_design`：Issue/worktree/baseline/Harness registration/checkpoint/Workflow/design authority 等 ticket-design 前提已核验；
  - `ticket_design_artifact`：设计 run 是否真实终态、canonical Notes/Context Plan 是否已回读并镜像一致；
  - `next_action_readiness`：对指定下一动作的 `ready/blocked/unknown/unsupported` + stable blockers/source refs；
  - `unknown_side_effects`：任何 unknown 必须优先阻断。
  `ready` 只表示对应动作证据充分，不等于执行授权。达到 `design-only` 终点绝不能生成 implementation authority；COMPANION-006 自身不负责 007 的常规多阶段连续推进。
- **中断恢复只核对已有产物，不重放。** preparation service 每一步先读取 durable preparation record 与真实 GitHub/Git/Harness/Workflow/document facts；已绑定产物一致则继续下一步，未知则 reconcile，冲突则停止。不得因为 UI/网络超时、模型回合结束或 DSH 静默而重复创建 Issue/worktree、重复登记 Ticket 或重复派发 Sylvia。
- **实现顺序：**preparation authorization/card schema + durable preparation record/typed receipt → GitHub creation/reconcile adapter → base/worktree freeze + Harness registration bootstrap → checkpoint/Workflow + ticket-design authority bootstrap → canonical Notes/mirror/readiness projection → Desktop/DSH 最小入口接线 → 定向测试 + 一条真实无预制 Ticket 的代表性 E2E。

## Deterministic Preflight

在 implementation 第一个不可重复副作用前必须由 Emilia + YCA 确认并记录，缺项即停止：
- trusted Engineering Card store 可读且 revision/content digest 未漂移；
- yuki-link repository identity、可信 base ref、解析出的 base commit OID 与允许 worktree root；
- GitHub 写入责任方/认证与“按 immutable ID + preparation identity 核对”的 adapter seam 已定义；现有 `githubIssueSource` 只读，不能被误当创建能力；
- `harness_register_ticket` / `harness_record_workflow` 的真实 public contract、初始 checkpoint/Workflow producer、trusted policy/authority source；
- Git/PowerShell/Node 与直接依赖就绪、Harness recording 健康、没有另一条活跃模型工作线；
- 当前 GitHub #131 scope 与本 canonical Notes digest 均重新读取，无未解释 drift。

## Test Plan

- **主 fixture / 无 Ticket 完整 bootstrap：**从真实 confirmed no-ticket card 开始，走 preparation record → GitHub create/reconcile seam → worktree + complete baseline → 真正的 `harness_register_ticket` → 真正的 `harness_record_workflow` → 真正的 `WorkflowAgentLauncher` / `ExecutionOperations`。只替换外部 GitHub transport 和实际模型 spawn，不替换整个 preflight、Harness registration 或 Workflow 注入。
- **授权边界：**未授权 Issue/worktree 创建、旧 revision、content digest drift、await 期间卡片修改均不能产生新的副作用；获准的 `design-only` 路径只到 design artifact/receipt，不生成 implementation/PR/merge/deploy authority。
- **Issue unknown outcome：**模拟远端创建成功但本地回执丢失，服务重启后凭 stable preparation identity + immutable Issue identity 只采用原 Issue；0/多候选或来源不可验证时保持 unknown，且第二次调用不创建第二张 Issue。
- **Worktree partial/recovery：**覆盖 branch 已建但 worktree 未完成、worktree 已建但未登记、path/branch 被其他 preparation 占用、默认分支前进等最小样例；原 frozen OID 不变，冲突保留现场，baseline gap 不被当作 ready。
- **Notes mirror/readiness：**本地 canonical Notes 写入成功但 GitHub mirror 失败、mirror digest drift、Workflow revision/assessment 漂移、design run 未终态、存在 unknown side effect 时均不得把 `ticket_design_artifact` 或后续 action readiness 标为 ready。
- 现有 COMPANION-005 dispatch dedupe tests 与 WorkflowAgentLauncher tests 继续作为下游回归，但不能替代上述无 Ticket 主 fixture。
- 完成实现后 full suite、typecheck/check、必要 package/smoke 由 Emilia + YCA 机械执行；不扩成无关 fault matrix。

## Out of Scope

不重写通用 workflow engine；不把 DSH/Desktop/WeChat 变成独立工程派发者；不新增“完全不建立 Issue/worktree 也能进入 Repository Engineer ticket-design”的第二设计路径；不实现 COMPANION-007 的跨常规阶段连续推进；不做 Engineering Card 视觉重构；不从本票授权推导 PR/merge/deploy 或 production 重启。

### Context Plan

- **Core:** GitHub #131 Acceptance Criteria；Source Spec #125 的 ID03 / ID05 / ID06 与 AC04 / AC06 / AC08 / AC10；根 `AGENTS.md`、`CONTEXT.md`；本 Notes；fixed point `30690d4146ed46b3d58837533c10b88b4c7a6cff`；`tools/companion-desktop/backend/engineering-cards.mjs`、`engineering-card-store.mjs`、`engineering-coordinator.mjs`、`session.mjs`、`worker.mjs`、`yca-engineering-client.mjs`、`github-issue-source.mjs`；`tools/codex-session-bridge/src/orchestration/companion-dispatch.mjs`、`workflow-agent-launcher.ts`、`execution-operations.ts`、`context-assembler.ts`、`harness-context-source.ts`；`tools/codex-session-bridge/src/harness/harness.ts`、`workflow.ts`、`workflow-model.ts`、`workflow-source.ts`、`src/mcp.js`。
- **Related:** COMPANION-005 / #130 的 confirmed-card/dispatch authority contract；ORCH-001 Notes 的 evidence/readiness 语义；ORCH-007 Notes 的 unified launcher / ExecutionOperations ownership；对应 engineering-card/dispatch、workflow、context、execution、launcher tests。
- **Retrieval:** 定向搜索 `explicit_new_requirement`、`confirmable`、`card_confirmations`、`CompanionDispatchService`、`harness_register_ticket`、`harness_record_workflow`、`prepare_ticket_resume`、`comparison_baseline`、`WORKFLOW_AGENT_*`、`REQUEST_CONFLICT`；不默认加载无关历史。
- **Expansion triggers:** GitHub 写入 adapter 无法提供可验证的创建关联；现有 Harness registration 无法安全承载 bootstrap；初始 Workflow/checkpoint 无法由真实事实构造；worktree/repository identity 冲突；canonical Notes mirror 无法避免授权与 scope 混淆；或任何拟执行动作超出 confirmed preparation authorization 时才扩大调查。

## Implementation Handoff

- 当前 worktree: `C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\companion-006`
- 当前 branch: `codex/companion-006-preparation`
- fixed point / 当前 HEAD（设计阶段）: `30690d4146ed46b3d58837533c10b88b4c7a6cff`
- ticket-design fresh run: `0d365c1c-7ce0-4728-a309-3d859e8325e3`（GPT-6 Sol medium，completed）
- design review: `d3eea7d5-3b8b-4bb6-a755-3305e4d71f8b`（GPT-6 Astra high，BLOCKED：5×P1 + 1×P2；本版已逐项吸收）
- model_usage before focused re-review: 2 runs；input `2,116,349`；cached input `1,916,672`；output `15,702`；reasoning output `2,647`；各阶段均低于仓库诊断参考目标，无 cost anomaly。
- Owner 已授权：按本版修订完成后执行一轮 fresh focused re-review；若该复核通过，直接进入 fresh implementation，implementation 使用 GPT-6 Sol high。

### Implementation session closeout

- 在固定点 `30690d4146ed46b3d58837533c10b88b4c7a6cff` 上实现无 Ticket 卡的逐项准备授权、SQLite v3 preparation record、GitHub Issue 身份核对与未知回执恢复、冻结 OID/worktree、完整 baseline 后的 Harness 登记、checkpoint/Workflow 记录，以及统一 launcher/ExecutionOperations 的 ticket-design 派发。Desktop 与 Companion MCP 仅传可信卡片身份；既有已核验 Ticket 派发保持原入口。
- 本地 `docs/implementation-notes/<ticket>.md` 经回读和 digest 核验后才镜像到 GitHub；镜像回执未知、内容漂移、Workflow 漂移、设计 run 未完成或其他未知副作用均使 typed readiness 失去 ready。`design-only` 的下一动作标为 unsupported，不产生 implementation authority。
- 定向验证：bridge `node --test test/companion-preparation.test.ts test/orchestration-companion-mcp.test.ts` 为 6/6；desktop `node --test test/engineering-cards.test.mjs test/renderer.test.mjs` 为 59/59；修改入口的 `node --check` 通过。包含真实 Harness register/Workflow record/WorkflowAgentLauncher/ExecutionOperations 的 fixture 仅替换 GitHub transport 与模型 spawn。
- 未在本 implementation session 运行 full suite、完整 typecheck、package/smoke 或真实无 Ticket 外部副作用 E2E；这些由 Emilia 后置验证。未执行 PR、push、merge、deploy 或 production restart。本地 commit 的精确 SHA 以提交后 handoff 为准。

### Primary Review finding-fix handoff

- 来源：`primary-review-findings.md`（Review run `c4fa6eac-eb81-4ee9-8198-0faabda584c6`）；修复基线 `e5466542883aa1f02687d7e9ac901277ccbc0852`，branch `codex/companion-006-preparation`，当前 worktree 见上文。本节随 finding-fix commit 保存，精确 SHA 以该 commit 的 Git 记录和交接回复为准。
- `STD-001`：`inspect/ensure` 在采用已登记路径前核对该路径真实 Git top-level 和 common-dir 与冻结绑定一致；不一致保留现场并拒绝采用。回归用相同 branch/commit 的替换仓库验证。
- `SPEC-001`：Desktop 对已知 preparation 冲突读回 durable receipt；仅当 `unknown_side_effects` 为空时返回带具体 blocker 和来源的 blocked receipt。回执不可核实或存在未知副作用仍为 unknown。既有 verified-ticket dispatch 未改。
- 定向验证：bridge `node --test --test-name-pattern='worktree recovery rejects|worktree recovery keeps' test/companion-preparation.test.ts`（2/2）；desktop `node --test --test-name-pattern='known preparation path conflict' test/engineering-cards.test.mjs`（1/1）；修改入口 `node --check` 通过；`git diff --check` 通过。两条新回归均先红后绿。
- Review policy：由 Emilia 接手 fresh focused re-review；本 fix session 不执行 Review。`STD-001`、`SPEC-001` 标记 fixed，尚未由 reviewer verified。full suite、完整 typecheck、真实外部 E2E 留给 Emilia 后置 validation；本次未执行 push、PR、merge、deploy 或 restart。

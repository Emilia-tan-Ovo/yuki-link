# ORCH-001 Implementation Notes

- Ticket: GitHub #90 — ORCH-001：Context Packet 与只读 Ticket 恢复准备
- Source Spec: GitHub #89 — Emilia Orchestration Consistency V0
- Fixed point: \`c0098c76675dc5cd4fc8c7170ec09d6ad113f26a\`
- Worktree: \`.local/worktrees/orch-001\`
- Branch: \`codex/orch-001-context-resume\`

## Implementation Decisions

- **Orchestration owns the context contract.** Add a small TypeScript orchestration module under the current YCA/bridge package. Its machine-facing interfaces and public Packet schema must be provider-neutral even though V0 has only the current Harness/Codex-backed production adapter. Do not move packages or build a general Brain/Provider abstraction in this Ticket.
- **Do not couple the Assembler to \`Harness.detail()\`, the \`Harness\` class, Codex manager/store shapes, or presentation DTOs.** The orchestration module owns a narrow \`ContextFactsSource\` seam; a Harness adapter projects only the facts required by ORCH-001. \`mcp.js\` stays a thin adapter.
- **Facts collection is strictly read-only.** \`assemble_ticket_context\` and \`prepare_ticket_resume\` must not call paths such as control refresh / workflow scan that can append Journal records, and must not mutate checkpoint, Workflow, Notes, Git, runtime or model state. Runtime execution facts are limited to Ticket bindings / explicit Workflow or checkpoint references; an empty observed set means “no active execution in the observed coverage”, not “no active execution exists globally”.
- **Public input stays minimal.** Both tools take only the registered Harness \`ticket_id\`, a bounded \`requested_action\`, and a bounded \`trigger\`. Caller-supplied cwd/HEAD/fixed point/session/run/phase/workflow revision/current-state claims are not accepted as authority.
- **Observed phase and requested action are different concepts.** V0 supports only the action kinds needed by the current Workflow slice; unknown action/source variants are explicit \`unsupported\`, never guessed as a nearby phase. Trigger only explains why assembly was requested and carries no authorization.
- **Evidence quality and action readiness are separate.**
  - \`integrity\` describes the evidence itself: \`complete / partial / stale / conflicted\`, with explicit conflicts, stale sources, unknowns and omissions.
  - \`action_readiness\` describes the requested action: \`ready / blocked / unknown / unsupported\`, with stable reason codes and source refs.
  - The same evidence set keeps the same integrity when requested action changes. \`ready\` means sufficient recovery/preparation evidence only; it is not execution authorization and cannot advance Workflow.
- **Resume advice is deterministic navigation, not a hidden Workflow engine.** Keep the Spec’s next-action concept as a structured recommendation produced by a small versioned policy: stable kind/reason codes, blockers and source refs, optionally a recommended transition. It never writes phase, executes a transition, or treats checkpoint prose as authority.
- **Provenance is fact-level.** Stable source records include at least source kind, locator/identity, revision or algorithm-tagged digest when available, real observation time and observation state. Critical facts point to source refs. \`assembled_at\` is not substituted for the source’s real observation time. Authority is defined by fact type (for example Git=current content, Workflow=recorded phase, checkpoint=recovery navigation, runtime=execution state); conflicts identify concrete claims rather than invalidating an entire source.
- **Current subject identity is versioned and provider-neutral.** Git collection stays inside the existing protected \`ChangesSource\` safety boundary, but exposes a dedicated current identity observation independent of the cumulative Changes list. Packet uses a \`SubjectIdentity\` envelope with \`kind\`, scheme/version, scope, completeness, digest and source refs; Git-specific HEAD/index/worktree/untracked details live in its typed payload.
  - Staged identity must reflect index content rather than rereading only the worktree.
  - Canonicalization fixes ordering, path encoding and layer semantics; timestamps are excluded from content digests.
  - Incomplete identities cannot prove equality; different schemes/scopes are not directly comparable.
  - Existing Workflow subject identity remains legacy and is not relabeled as the new scheme.
- **Document parsing is behind a versioned adapter.** V0 keeps the existing Markdown persistence format. The document adapter returns normalized fields plus source location, document digest and parse status such as \`observed / missing / malformed / unsupported-version / reference-only\`.
  - Context Plan recognizes only the established \`Core / Related / Retrieval / Expansion triggers\` subsection contract and emits bounded projections/references.
  - Checkpoint front matter and selected recovery sections may be read as declarations, but natural-language Side effects / Next action / finding text are not upgraded to verified machine facts without external evidence.
  - Do not introduce sidecar dual-write or migrate checkpoint/Notes format in this Ticket.
- **V0 does not read GitHub Issue/Notes bodies at runtime.** Ticket/Spec/reference-only locations are retained as retrieval references. A remote-only source that is not materialized locally stays explicit as \`reference-only\`; it is never treated as verified content.
- **Packet size is deterministically bounded.** Define a versioned budget/omission policy with stable ordering, deduplication, per-array/text limits and a total byte budget. Identity, conflicts, unknown side effects, blockers and their retrieval refs have priority and may not be silently trimmed. Omission entries state category/reason/count or scope/retrieval reference. The 2k–5k token range remains a target, not a Workflow/model hard stop; without a fixed tokenizer report bytes and only clearly labeled estimates.
- **Schema evolution is explicit.** Packet schema/version, stable reason codes, source variants, policy version and identity scheme/version are machine contracts; display prose is not. Additive optional fields may evolve compatibly; semantic changes or new required fields require a major contract version. \`packet_id\` identifies one assembly instance and is distinct from subject/content identity.

## Implementation Sequence

1. Define the versioned Context request/Packet/provenance/integrity/readiness/recommendation/SubjectIdentity contracts.
2. Introduce the provider-neutral \`ContextFactsSource\` seam plus the current Harness adapter and strict no-write facts path; add the minimal project/current-content factual projections needed by the adapter.
3. Add the versioned document adapter for checkpoint and local Implementation Notes / Context Plan.
4. Implement Context Assembler with fact-level provenance, integrity calculation, execution coverage and deterministic budget/omission handling.
5. Implement the deterministic Resume Advisor and \`prepare_ticket_resume\` recovery projection.
6. Register \`assemble_ticket_context\` and \`prepare_ticket_resume\` as public read-only observe tools through the thin MCP adapter.
7. Verify behavior through the public Streamable HTTP MCP seam with real Harness/Journal fixtures and a controllable runtime adapter.

## Testing Decisions

- Primary seam: public MCP/API, not internal helper call order.
- Repeated calls and service restart must not append Journal records, change Workflow/checkpoint/files, or start a model/task.
- With the same evidence and different requested actions, evidence integrity remains stable while action readiness may differ.
- Cover stale checkpoint, active/unknown observed execution, unknown side effect and fact-level source conflict without choosing a winner by timestamp.
- Cover index content differing from worktree content plus protected/incomplete identity; incomplete identity cannot masquerade as a comparable digest.
- Cover legacy Ticket / no Workflow, old checkpoint, missing or remote-only Notes, malformed/unsupported document schema: no crash, no invented state, no automatic migration.
- Freeze a small contract fixture for additive optional fields, unknown action/source variants, legacy identity and stable reason-code behavior.
- Cover budget overflow so omissions are deterministic and safety-critical blockers cannot be trimmed into a \`ready\` result.
- Add focused adapter-contract tests for normalized facts/provenance/parse status; do not create a second production Provider or a large Cartesian fixture matrix.

## Deferred

- Package extraction or a general Repository Engineer / Brain Provider framework.
- DeepSeek / DS Harness integration or any second production provider.
- Global discovery of every active process/model line outside the Ticket’s observable coverage.
- Non-Git subject identity adapters and full legacy Journal migration.
- Structured sidecar format, Markdown dual-write, or persistence migration tooling.
- Launcher/reservation/automatic resume execution; these belong to later ORCH Tickets.
- Engineering Memory V0, Companion Memory, RAG/embedding, GitHub runtime client and UI.
- Exact tokenizer optimization or semantic ranking.

### Context Plan

- **Core:** GitHub #90 acceptance criteria；GitHub #89 Context Packet / source-of-truth / Testing decisions；本 Notes；根 \`AGENTS.md\`、\`CONTEXT.md\`；\`tools/codex-session-bridge/src/harness/{harness,workflow,workflow-source,workflow-model,changes,changes-source,codex-source,controls,conversations,model}.ts\`；\`tools/codex-session-bridge/src/{mcp,http}.js\`；对应 workflow/changes/execution-gate tests。
- **Related:** \`.workflow/skills/engineering-workflow/{checkpoint-template.md,recovery.md}\` 用于现有 checkpoint/recovery schema；既有 HARNESS Implementation Notes 的 Context Plan 仅作格式先例。
- **Retrieval:** 定向搜索 \`detail(\`、\`executionGate\`、\`refreshControls\`、\`scan(\`、\`subjectIdentity\`、\`startEntries\`、\`WorkflowAssessment\`、\`currentStatus\`、\`Context Plan\`、\`source_ref\`、\`comparison_baseline\`；需要 source shape 时只读相关 symbol/fixture。
- **Expansion triggers:** 只有在现有 Harness 无法提供严格 no-write factual projection、Git index identity 无法在现有安全边界内可靠计算、或现有 checkpoint/Notes schema 无法区分 missing/malformed/unsupported/reference-only 时才扩大调查；不要提前引入第二 Provider、GitHub runtime client、Memory、launcher 或持久化迁移。

## Implementation Handoff

- **来源与身份：** 按 GitHub #90、source Spec #89 的 ORCH-001 相关段、本 Notes、根 `AGENTS.md` / `CONTEXT.md` 和 `.local/workflow-state/ORCH-001.md` 实现。worktree 为 `.local/worktrees/orch-001`，branch 为 `codex/orch-001-context-resume`，fixed point 与开始 HEAD 均为 `c0098c76675dc5cd4fc8c7170ec09d6ad113f26a`。精确提交 SHA 在提交后由外层 checkpoint 记录；本 handoff 随实现同一提交保存。
- **实际实现：** 新增 provider-neutral `ContextFactsSource`、版本化 Context Packet / Resume policy contract、Harness facts adapter、`markdown-context-v0` document adapter、deterministic Context Assembler / Resume Advisor；通过薄 `src/mcp.js` 注册只读 `assemble_ticket_context` 与 `prepare_ticket_resume`。Assembler 不依赖 `Harness.detail()`、presentation DTO、Codex manager/store，也不调用 `scan` / `refreshControls`。
- **subject 与 provenance：** 在既有 `ChangesSource` 保护边界内新增 `yuki-git-subject` v1 identity，分别读取 Git index blob、worktree 与 untracked 内容，固定 UTF-8 JSON path encoding、layer semantics、ordering 与 algorithm-tagged digest；不完整/protected identity 的 digest 为 `null`。旧 Workflow subject 只以 `legacy-workflow-subject` 投影，不冒充新 scheme。Packet 的动态事实、conflict、stale、unknown、execution coverage 与 recommendation 均携带 source refs；GitHub Ticket/Spec 保持 `reference-only`。
- **文档与预算：** Markdown 仍是 V0 持久化格式；checkpoint / Context Plan 明确区分 `observed`、`missing`、`malformed`、`unsupported-version`、`reference-only`。预算使用 `context-budget-v1` 的稳定顺序、去重、item/text/byte limits 和显式 omission；identity/conflict/unknown side effect/blocker/retrieval ref 保持可见。readiness 与 evidence integrity 独立计算，recommendation 只导航且不授权执行。
- **定向测试：** `node --test test/orchestration-context.test.ts` → exit 0，5/5；覆盖 public Streamable HTTP MCP、重复调用和 service reconstruction 不写 Journal/文件或启动模型、不同 action 的 integrity 稳定、active/unknown execution、stale/conflict、index/worktree/untracked identity、protected/incomplete identity、legacy/no Workflow、missing/malformed/unsupported/reference-only documents、预算 omission 与 unsupported action。`node --test test/harness-changes.test.ts` → exit 0，9/9；`node --test test/harness-execution-gate.test.ts` → exit 0，10/10；`npm run typecheck -- --pretty false` → exit 0。
- **Outer full suite 与兼容修复：** outer Emilia 首轮 `npm test` 共 211 tests：205 pass、5 fail、1 skip。5 个失败均为新增 `assemble_ticket_context`、`prepare_ticket_resume` 后旧工具枚举/schema count 断言未同步；本 fresh regression-fix 将公开工具总数更新为 12/24，并让 Harness 断言显式只检查既有八类 computer tools 的 `ticket_id` schema，未修改业务实现。最小定向命令 `node --test --test-name-pattern 'real MCP HTTP clients reconnect|real stdio service executes scripts|八类工具保留来源事实|同 request 的 Ticket 身份不可改变|service epochs reject previous IDs' test/bridge.test.js test/computer.test.js test/harness-computer.test.ts test/harness-tasks.test.ts test/tasks.test.js` → exit 0，5/5。
- **环境准备：** 首次 typecheck 直接证明预置 junction 的依赖树缺少 lockfile 声明的 `react-diff-view`；随后按现有 `package-lock.json` 执行 `npm ci --ignore-scripts`（exit 0），并执行 `npm run build:ui`（exit 0）恢复既有 UI 测试所需构建产物。`node_modules` / `dist` 均未纳入 Ticket diff。
- **未运行：** 本 regression-fix session 未重跑 full suite；按 delegated workflow 由 outer Emilia + YCA 重跑。未做真实部署、GitHub runtime 读取、launcher/reservation、Memory、Provider framework、DS 接入、RAG 或 UI 工作。
- **Review policy：** `delegated`，接收方为 outer Emilia。primary Review 尚未启动，本 implementation session 未调用 `code-review` / `review-change`，未宣称 Review 或 Acceptance 通过。
- **已知边界：** execution coverage 仅覆盖本 Ticket bindings 与显式 Workflow runtime refs，`global: false`；无固定 tokenizer 时只报告 UTF-8 bytes；remote-only Ticket/Spec 不在 runtime 拉取。以上是 contract 的显式 V0 边界。
- **下一步：** outer Emilia 以 fixed point、最终 commit、GitHub #90/#89、本 handoff、定向测试结果和实际 diff 启动 fresh primary Review；实现 session 到此停止。

# COMPANION-006 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-27T17:35:17.469Z
- Ticket / Issue：COMPANION-006 / GitHub \#131
- 来源：GitHub \#131；GitHub \#125；docs/implementation-notes/COMPANION-006.md
- worktree：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-006
- branch：codex/companion-006-preparation
- fixed point：30690d4146ed46b3d58837533c10b88b4c7a6cff
- HEAD：a4bbf7bbf0461702c56283731425fd705ddaa36f

## 过程与结果

实现并验收无 Ticket 新需求的受控 preparation 链：显式版本化准备授权、可恢复 Issue/worktree 身份、真实 Harness/Workflow/ExecutionOperations bootstrap、分层 readiness 与中断去重；Primary Review 的 STD-001/P1 与 SPEC-001/P2 均经 fresh focused re-review 验证关闭。最终 full validation 与代表性 Acceptance slice 全绿；PR、merge、deploy、production restart 均未执行。

## implementation

- 状态：recorded
- 摘要：主实现提交 61c54db…，随后机械修正工具数量断言 e546654…；Primary Review finding 修复提交 628c22e… 与 a4bbf7b…。首个 Sol-high 实现 run 超时但保留 delta，恢复后完成提交；没有把 preparation record 扩成第二套 Workflow/run owner。
- 证据来源：docs/implementation-notes/COMPANION-006.md；Git HEAD a4bbf7bbf0461702c56283731425fd705ddaa36f
- session：791216c8-0b71-43d9-9aab-e920a609acc0；run：23afb472-9c82-4200-957e-3f114776b549、b0662a08-38f2-4c99-b661-7df096825455；model：gpt-6-sol；reasoning：high
- session：b5d317d1-0b27-4c3e-bc06-197b5942315a；run：0d2a2602-fbf3-480d-b6fe-cb075d81321e；model：gpt-6-sol；reasoning：medium
- session：610c8463-e833-4d5b-b23c-8b560985e124；run：ebaf5b12-98ef-4264-b047-6da41b9d071b；model：gpt-6-sol；reasoning：medium

## review

- 状态：recorded
- 摘要：Fresh Primary Review 找到 STD-001/P1（worktree repository identity 恢复核验）与 SPEC-001/P2（确定性冲突被泛化为 unknown）。Focused re-review \#1 验证 STD-001；\#2 在真实 Companion MCP HTTP→Desktop client 边界验证 SPEC-001，并确认当前修复未触碰已验证的 STD-001。
- 证据来源：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\workflow-artifacts\\COMPANION-006-design\\primary-review-findings.md；C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\workflow-artifacts\\COMPANION-006-design\\focused-rereview-1.md；Harness Workflow revision 1
- session：525b03e2-5828-4f32-b014-b97e561612ad；run：c4fa6eac-eb81-4ee9-8198-0faabda584c6；model：gpt-6-sol；reasoning：high
- session：2d1d8a28-ce92-4d17-acd6-d40ca1accbf2；run：723a2df2-81ed-4da2-8dc8-f6f92f2c80fd；model：gpt-6-sol；reasoning：medium
- session：20905d5f-af17-4213-b0e0-17784028deff；run：5c396769-43af-4cf0-82af-0640b950441b；model：gpt-6-sol；reasoning：medium

## acceptance

- 状态：recorded
- 摘要：Emilia 以外部事实逐条验收 \#131 五条 AC，没有启动 Acceptance 模型。Desktop final full 171/171 \+ check；Bridge final full 299 pass / 1 skip / 0 fail \+ typecheck/typecheck:ui；Desktop/Bridge acceptance slices 各 6/6。代表性主 fixture 从 confirmed no-ticket card 走真实 Harness Workflow \+ ExecutionOperations，仅替换票据 Test Plan 明确允许替换的外部 GitHub transport 与实际 model spawn。
- 证据来源：.local/workflow-state/COMPANION-006-acceptance.md；Harness Workflow revision 1
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：Harness 截止 Acceptance 观察到 9 个有 usage receipt 的模型 run：28,782,897 input、27,810,816 cached input、127,695 output。首个 timed-out implementation run 无 usage receipt，未补造。最大异常来自恢复同一肥 Sol-high implementation thread：单次约 21.9M raw input、21.5M cached；后续 Review/fix 均改用 fresh 窄上下文。
- 证据来源：.local/workflow-state/COMPANION-006.md；Harness Context Packet 18cb4a81-b8da-4a80-b33d-5b9b5005c3c1

## 失败 / 重试

- 状态：recorded
- 摘要：主 implementation run 23afb…因 30 分钟 RUN\_TIMEOUT 终止，delta 保留并从 durable state 恢复；曾有两处旧 tools.length=33 断言因新增两个 Companion 工具而失败，机械更新为 35 后 full suite 全绿；中途电脑/tunnel 重启导致 final validation 被主动停止一次，重启后从头重跑并通过。没有最终未解决测试失败。
- 证据来源：.local/workflow-state/COMPANION-006.md；.local/workflow-state/COMPANION-006-acceptance.md

## Findings 与修复

- 状态：recorded
- 摘要：STD-001/P1 verified：恢复采用 worktree 前核验实际 Git top-level/common-dir 与冻结身份/registry。SPEC-001/P2 verified：仅显式 allowlist 的确定性 preparation conflict code 可跨 Companion MCP/Desktop boundary，非 allowlist 与未知副作用仍 fail-closed。Primary Review findings 全部关闭。
- 证据来源：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\workflow-artifacts\\COMPANION-006-design\\primary-review-findings.md；C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\workflow-artifacts\\COMPANION-006-design\\focused-rereview-1.md；Harness Workflow revision 1

## 人工介入点

- 状态：recorded
- 摘要：Owner 明确批准 Astra-high 设计审计与 Sol-high implementation；多次要求暂停/继续及一次电脑重启，均按 durable checkpoint 恢复。外部真实 GitHub Issue/model side effect 未用于 Acceptance，因为需要真实 Engineering Card 的逐项 preparation authorization；未扩大为票据实现授权。
- 证据来源：.local/workflow-state/COMPANION-006.md；GitHub \#131

## PR

- 状态：pending
- 摘要：尚未创建或 push PR；本轮未获 PR/push 授权。
- 证据来源：unknown / 尚无来源

## Merge

- 状态：pending
- 摘要：尚未 merge；未授予 merge/deploy/production restart 权限。
- 证据来源：unknown / 尚无来源

## Raw evidence（仅引用）

- checkpoint：available
  - 本机位置：.local/workflow-state/COMPANION-006.md
  - 观察时间：2026-09-27T17:35:17.469Z；适用内容 / 来源身份：SHA256 460d72f85daa599f5ebf1331a990d6510d964f388b783cee9285c008d836e7b6; phase closeout; HEAD a4bbf7b

- acceptance-report：available
  - 本机位置：.local/workflow-state/COMPANION-006-acceptance.md
  - 观察时间：2026-09-27T17:35:17.469Z；适用内容 / 来源身份：SHA256 d7fd6f55a04506171f5c1e214afd562c9db67e50efb331cf613f35ec5a0f7dbc; all five \#131 AC PASS

- implementation-notes：available
  - 本机位置：docs/implementation-notes/COMPANION-006.md
  - 观察时间：2026-09-27T17:35:17.469Z；适用内容 / 来源身份：SHA256 ff1ea1028211faee36364e7231b069056bf726ff0f2db8e6335d44aabbab1fac; GitHub \#131 mirror matched

- primary-review-report：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\workflow-artifacts\\COMPANION-006-design\\primary-review-findings.md
  - 观察时间：2026-09-27T17:35:17.469Z；适用内容 / 来源身份：Primary Review run c4fa6eac-eb81-4ee9-8198-0faabda584c6; 2 findings

- focused-rereview-1：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\workflow-artifacts\\COMPANION-006-design\\focused-rereview-1.md
  - 观察时间：2026-09-27T17:35:17.469Z；适用内容 / 来源身份：STD-001 verified; SPEC-001 not yet verified at 628c22e subject

- workflow-receipt：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\workflow-artifacts\\COMPANION-006-design\\acceptance-workflow-receipt.md
  - 观察时间：2026-09-27T17:35:17.469Z；适用内容 / 来源身份：Workflow revision 1, event 282a822e-4d10-4edc-9eb0-1e6695145b13, applicability verified

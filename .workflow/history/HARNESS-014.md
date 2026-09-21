# HARNESS-014 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-21T14:43:30.261Z
- Ticket / Issue：HARNESS-014 / GitHub \#81
- 来源：docs/implementation-notes/HARNESS-014.md；docs/specs/yuki-harness-v0.md；.local/workflow-state/HARNESS-014-review.md；.local/workflow-state/HARNESS-014-focused-review.md；.local/workflow-state/HARNESS-014-acceptance.md；.local/workflow-state/HARNESS-014.md；GitHub \#81 / PR \#82
- worktree：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-014
- branch：codex/harness-014-conversation-density
- fixed point：d3b68f2f700669b366f5bc8a768638918718d9c8
- HEAD：015149f48df04ef6a74790c329097ae24e27e0b4

## 过程与结果

HARNESS-014 将 Conversation 的 execution-only 聚合泛化为 provider-neutral auxiliary grouping：自然语言 message 保持直接阅读，其余辅助记录默认折叠，安全连续记录聚合为 ×N，singleton 不再显示 ×1，并移除底部只读 Composer 占位。Primary Review 的 F-01/F-02 经 fresh finding-fix 与 focused re-review verified；final full suite 201 tests / 200 pass / 0 fail / 1 skip，真实 Chrome Acceptance 通过。PR \#82 已由 Owner 合并为 b3d0fef，\#81 自动关闭；resident 7391/7394 尚未部署该 merge。

## implementation

- 状态：recorded
- 摘要：fresh Sol medium 完成 Conversation 辅助记录泛化、默认折叠、×N 聚合、singleton 去 ×1、Composer 占位移除及定向测试；Primary Review 后另由 fresh Sol medium 只修 F-01/F-02。最终产品 subject 为 015149f，full suite 201 / 200 pass / 0 fail / 1 skip。
- 证据来源：docs/implementation-notes/HARNESS-014.md；.local/workflow-state/HARNESS-014.md；.local/workflow-state/HARNESS-014-acceptance.md
- session：079182da-e18b-48fa-8996-cfe8bb2df150；run：cfd4d698-af47-40e2-9dd3-ae33989abf86；model：gpt-5.6-sol；reasoning：medium
- session：9dd69f0b-e580-4891-b0c1-e5badb8366f2；run：66f3ed17-ef0b-4c5a-926e-f50eab5e598e；model：gpt-5.6-sol；reasoning：medium

## review

- 状态：recorded
- 摘要：fresh Primary Review 检查完整 subject 的 Standards 与 Spec：Standards 0 findings，Spec 报告 F-01/F-02；fresh focused re-review 对修复提交 015149f 判定 passed，F-01/F-02 均 verified，0 new findings。
- 证据来源：.local/workflow-state/HARNESS-014-review.md；.local/workflow-state/HARNESS-014-focused-review.md
- session：990ac444-6436-4bf1-8758-a7585052aff8；run：acebd0ac-9878-46b2-8516-81d7411380e4；model：gpt-5.6-sol；reasoning：medium
- session：22f56961-a7da-4f5c-b674-e0fae0795959；run：5a083cb2-041b-4ff3-aabe-bffaa7f94cfd；model：gpt-5.6-sol；reasoning：medium

## acceptance

- 状态：recorded
- 摘要：Emilia deterministic Acceptance，无 Acceptance 模型 session。final full suite 与 production UI build 通过；隔离 runtime \+ 真实 Chrome 验证 0 个 ×1、×17/×4/×2 聚合、默认折叠、逐层展开/Advanced raw evidence、滚动锚点、Review/Focused relation、Diff、响应式、Composer 移除与网络健康。Workflow rev3 applicability verified。
- 证据来源：.local/workflow-state/HARNESS-014-acceptance.md；.local/workflow-state/HARNESS-014.md
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：已明确记录 5 条模型 run：raw input 9,775,712，cached input 9,274,624，output 79,701；仅作工程成本诊断，不等同订阅额度。implementation/finding-fix 高于参考线，但恢复后未重复开 run，也未升级模型。
- 证据来源：.local/workflow-state/HARNESS-014.md

## 失败 / 重试

- 状态：recorded
- 摘要：Primary Review 发现 F-01 turn.failed 边界与 F-02 recovery/attribution gap 边界，均最小修复并 verified。真实浏览器临时 runtime 的有界 timeout 留下 stale lock，确认原 PID 已死亡后仅移动 lock 备份再继续；resident 未受影响。Structured Workflow rev1 因不可验证 artifact 形状为 unknown，收紧可验证证据后 rev2/rev3 applicability verified。试图事后将已绑定 Main 的 reviewer 改挂 child Conversation 被 ATTRIBUTION\_CONFLICT 正确拒绝，未改写历史。
- 证据来源：.local/workflow-state/HARNESS-014-review.md；.local/workflow-state/HARNESS-014-focused-review.md；.local/workflow-state/HARNESS-014-acceptance.md；.local/workflow-state/HARNESS-014.md

## Findings 与修复

- 状态：recorded
- 摘要：F-01：turn.failed 未成为 failure boundary；补可信 issue projection 后 verified。F-02：recovery payload.gaps 与 attribution unknown 未进入 issues；补结构化 gap/归属未知 projection 后 verified。最终 fresh focused re-review passed，无 open finding。
- 证据来源：.local/workflow-state/HARNESS-014-review.md；.local/workflow-state/HARNESS-014-focused-review.md

## 人工介入点

- 状态：recorded
- 摘要：Owner 最终手动 merge PR \#82。Emilia 在验收期间仅对隔离临时 runtime 的 stale lock 做了 PID 死亡核验后移位备份，并清理临时 Chrome/CDP；未修改 resident 7391/7394。
- 证据来源：.local/workflow-state/HARNESS-014.md；.local/workflow-state/HARNESS-014-acceptance.md；GitHub PR \#82

## PR

- 状态：recorded
- 摘要：PR \#82：feat: 收缩并聚合 Conversation 辅助记录；head codex/harness-014-conversation-density → base codex/codex-session-bridge；创建时 OPEN/CLEAN，body 含 Closes \#81，GitHub checks 数为 0。
- 证据来源：GitHub PR \#82；.local/workflow-state/HARNESS-014.md

## Merge

- 状态：recorded
- 摘要：Owner 于 2026-09-21T14:29:10Z 合并 PR \#82；merge commit b3d0fef85b36500b79729535ed72d308762553dc。\#81 于 14:29:11Z 自动关闭；fetch 后 origin/codex/codex-session-bridge 正是该 merge commit，且包含 final product HEAD 015149f。resident YCA/Harness 尚未 rollout 本 merge。
- 证据来源：GitHub PR \#82；GitHub \#81

## Raw evidence（仅引用）

- implementation-notes：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-014\\docs\\implementation-notes\\HARNESS-014.md
  - 观察时间：2026-09-21T14:43:30.261Z；适用内容 / 来源身份：tracked in final product HEAD 015149f and merge b3d0fef

- primary-review：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-014\\.local\\workflow-state\\HARNESS-014-review.md
  - 观察时间：2026-09-21T14:43:30.261Z；适用内容 / 来源身份：reviewed HEAD 0d028fe; Standards pass, Spec F-01/F-02

- focused-review：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-014\\.local\\workflow-state\\HARNESS-014-focused-review.md
  - 观察时间：2026-09-21T14:43:30.261Z；适用内容 / 来源身份：fix subject 015149f; F-01/F-02 verified

- acceptance：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-014\\.local\\workflow-state\\HARNESS-014-acceptance.md
  - 观察时间：2026-09-21T14:43:30.261Z；适用内容 / 来源身份：deterministic Acceptance passed on final HEAD 015149f

- checkpoint：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-014\\.local\\workflow-state\\HARNESS-014.md
  - 观察时间：2026-09-21T14:43:30.261Z；适用内容 / 来源身份：closeout checkpoint through PR \#82 OPEN/CLEAN before Owner merge; merge fact independently verified later

- workflow-receipt：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-014\\.local\\workflow-state\\HARNESS-014-workflow-receipt.json
  - 观察时间：2026-09-21T14:43:30.261Z；适用内容 / 来源身份：local receipt for Workflow rev3 applicability verified before merge

- merge-receipt：not-applicable
  - 本机位置：not-applicable
  - 观察时间：2026-09-21T14:43:30.261Z；适用内容 / 来源身份：GitHub PR \#82 MERGED at 2026-09-21T14:29:10Z; \#81 CLOSED at 14:29:11Z; merge b3d0fef

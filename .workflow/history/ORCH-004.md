# ORCH-004 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-22T16:51:45.005Z
- Ticket / Issue：ORCH-004 / GitHub \#94
- 来源：docs/implementation-notes/ORCH-004.md；.local/workflow-state/ORCH-004.md；.local/workflow-state/ORCH-004-focused-review.md；.local/workflow-state/ORCH-004-acceptance.md；GitHub PR \#99；GitHub \#94
- worktree：C:/Users/KQ\_Sh/Desktop/yuki-link/.local/worktrees/orch-004
- branch：codex/orch-004-delegated-implementation-launcher
- fixed point：bf149f9217201c52355dcfb8f23efcada4f1084f
- HEAD：6d09433cd7ac43528ed0436efa66fabf5b926135

## 过程与结果

ORCH-004 交付 start\_ticket\_implementation 安全高层纵切：固定 delegated/Main/fresh 契约，复用 ORCH-002 durable execution/reconcile，引入 versioned authority 与 compare-only caller preconditions，并修复 host executable lexical/canonical alias 边界。最终 deterministic Acceptance 11/11 AC 通过，PR \#99 已合并，\#94 已关闭。过程中发生一次重复 focused reviewer 编排异常；它暴露的真实 junction 漏洞已修复并验证，该重复启动本身保留为后续 orchestration consistency 证据。

## implementation

- 状态：recorded
- 摘要：主实现与两轮 finding fix 完成；最终 HEAD 6d09433，final launcher 11/11、typecheck exit 0、full suite 237 tests / 236 pass / 0 fail / 1 skip。
- 证据来源：docs/implementation-notes/ORCH-004.md；.local/workflow-state/ORCH-004-final-fix-handoff.md；.local/workflow-state/ORCH-004.md
- session：9f1f3d39-d10f-4d19-8b5d-bea133ad481e；run：b438a987-35f0-4545-902f-ca6f3cf89cad；model：gpt-5.6-sol；reasoning：high
- session：9ca045f1-c914-429b-a029-6506031483a5；run：1211e7e0-4f2f-4a61-86af-3f490b2d5470；model：gpt-5.6-sol；reasoning：high
- session：edccc7aa-ed0a-4f6e-8647-f7aa9d23f91f；run：f3a922ae-231c-4e4d-8827-e4e39ed274cd；model：gpt-5.6-sol；reasoning：medium

## review

- 状态：recorded
- 摘要：Primary full Review 产生 6 条 finding；修复后最终 focused Review 6/6 verified、0 open、passed。第一次 focused review 后误启动重复 reviewer，违反一次性复核约束；其发现的 junction/alias 漏洞在 final fix 后由同一 reviewer continuation 验证。
- 证据来源：.local/workflow-state/ORCH-004-review.md；.local/workflow-state/ORCH-004-focused-review.md；.local/workflow-state/ORCH-004.md
- session：5ed511f7-26e8-4203-9d89-37bddeda3f63；run：b2fd9ba9-7831-4de4-807c-cab619685d0d；model：gpt-5.6-sol；reasoning：high
- session：f4b18088-4895-4b9d-b860-c8c0a08d4fa0；run：862692ea-3f2d-47d9-ae85-742cfe46fd93；model：gpt-5.6-sol；reasoning：medium
- session：c3af02a9-05d0-44ba-b472-5bca06e1c360；run：9be6a912-fc5f-44d8-a775-39b343874779、60f140bc-8250-4fb6-b471-1e349a7e22fd；model：gpt-5.6-sol；reasoning：medium

## acceptance

- 状态：recorded
- 摘要：Emilia \+ YCA deterministic Acceptance；GitHub \#94 的 11 条 Acceptance Criteria 全部 pass，没有启动 Acceptance 模型。最终 full suite 237 / 236 pass / 0 fail / 1 skip。
- 证据来源：.local/workflow-state/ORCH-004-acceptance.md；GitHub \#94
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：工程诊断统计：9 条模型 run，raw input 21,169,224，cached input 20,214,528，output 167,570；这些不是产品额度 1:1 计费。最终 full suite 237 tests，236 pass，0 fail，1 skip。
- 证据来源：.local/workflow-state/ORCH-004.md

## 失败 / 重试

- 状态：recorded
- 摘要：发生一次重复 focused reviewer 编排异常，违反 single-model-line / 最多一次 focused re-review 约束；重复 reviewer 发现真实 executable junction/alias 边界漏洞。漏洞已由 commit 6d09433 修复并验证，重复启动本身作为后续 orchestration consistency 证据保留。
- 证据来源：.local/workflow-state/ORCH-004.md；.local/workflow-state/ORCH-004-focused-review.md

## Findings 与修复

- 状态：recorded
- 摘要：Primary Review：STD-001/STD-002、SPEC-001～SPEC-004 共 6 条 finding。最终 focused Review：6/6 verified，0 open。最后关闭的根因是 host executable lexical candidate 位于 worktree、canonical target 在树外的 junction/alias 绕过。
- 证据来源：.local/workflow-state/ORCH-004-review.md；.local/workflow-state/ORCH-004-focused-review.md；.local/workflow-state/ORCH-004-final-fix-handoff.md

## 人工介入点

- 状态：recorded
- 摘要：Owner 批准 Proposal D，并额外批准 fresh Astra high 做长期架构挑战；后续明确要求 stop-expansion/尽快收尾。Acceptance 与 GitHub lifecycle 均改由 Emilia \+ YCA deterministic 执行。
- 证据来源：.local/workflow-state/ORCH-004.md

## PR

- 状态：recorded
- 摘要：PR \#99 已创建并包含 Closes \#94。
- 证据来源：GitHub PR \#99

## Merge

- 状态：recorded
- 摘要：PR \#99 于 2026-09-22T16:50:42Z 合并；merge commit 66b8912c7ad48490172a1acc4e4cb86e387834a3；GitHub \#94 于 16:50:43Z 自动关闭。
- 证据来源：GitHub PR \#99；GitHub \#94

## Raw evidence（仅引用）

- checkpoint：available
  - 本机位置：.local/workflow-state/ORCH-004.md
  - 观察时间：2026-09-22T16:51:45.005Z；适用内容 / 来源身份：checkpoint final pre-closeout; HEAD 6d09433

- implementation-notes：available
  - 本机位置：docs/implementation-notes/ORCH-004.md
  - 观察时间：2026-09-22T16:51:45.005Z；适用内容 / 来源身份：Owner-confirmed Proposal D \+ Implementation Handoff

- primary-review：available
  - 本机位置：.local/workflow-state/ORCH-004-review.md
  - 观察时间：2026-09-22T16:51:45.005Z；适用内容 / 来源身份：primary full Review report

- focused-review：available
  - 本机位置：.local/workflow-state/ORCH-004-focused-review.md
  - 观察时间：2026-09-22T16:51:45.005Z；适用内容 / 来源身份：final passed report; SHA-256 2e0302958242a128bc4ad89b66ec1c48cd599fc782e95e35ac88804a1bd61138

- final-fix-handoff：available
  - 本机位置：.local/workflow-state/ORCH-004-final-fix-handoff.md
  - 观察时间：2026-09-22T16:51:45.005Z；适用内容 / 来源身份：final fix commit 6d09433

- acceptance：available
  - 本机位置：.local/workflow-state/ORCH-004-acceptance.md
  - 观察时间：2026-09-22T16:51:45.005Z；适用内容 / 来源身份：deterministic Acceptance 11/11 AC pass

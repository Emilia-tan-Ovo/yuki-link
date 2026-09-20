# HARNESS-004 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-20T00:26:46.400Z
- Ticket / Issue：HARNESS-004 / GitHub \#44
- 来源：docs/implementation-notes/HARNESS-004.md；.local/workflow-state/HARNESS-004.md；.local/workflow-state/HARNESS-004-review.md；.local/workflow-state/HARNESS-004-focused-review.md；.local/workflow-state/HARNESS-004-acceptance.md
- worktree：C:/Users/KQ\_Sh/Desktop/yuki-link/.local/yuki-harness-v0-004
- branch：codex/yuki-harness-v0-004
- fixed point：14f110c60a64dd808fb0aad1a0028a17444502fc
- HEAD：ad0f15f3f2ca14a5bfff82f4ff62d2a8dcac2f70

## 过程与结果

HARNESS-004 为 21 个公开 MCP 工具增加 Harness-owned 系统级 recording execution gate：新副作用在 recording-failed/collection-failed/unavailable 时 fail-closed，只读观察与已有运行 stop 继续并暴露 evidence gap，恢复不自动重放。primary Review 与 focused re-review 均 0 findings；Emilia deterministic Acceptance 5/5 AC PASS。最终 full suite 135/140 pass、4 fail、1 skip，剩余 4 项已确认不属于 \#44：3 项 Codex executable discovery 在默认分支同样失败，1 项为本票前已知 task timing/status 问题。未部署 resident YCA。

## implementation

- 状态：recorded
- 摘要：实现提交 ed44a889；环境 preflight 曾误判 node\_modules junction 可用，首个 implementation run 因 SDK 缺失停止，Emilia 用 npm ci --offline 修复后 fresh Sol high 完成实现。Acceptance 边界发现 5 个旧 text/workflow fixture 未注入 Harness，机械增加 1 行 healthy test gate 并提交 ad0f15f；生产代码未变化。
- 证据来源：docs/implementation-notes/HARNESS-004.md；.local/workflow-state/HARNESS-004.md
- session：ad695b28-e89a-4195-b2bb-97e8437e05c4；run：51811574-f945-4008-8a85-6a98aa3da455；model：gpt-5.6-sol；reasoning：high
- session：bb208101-c506-480f-8f23-cb9760f57e04；run：25506eae-1ae7-44e2-9142-36b80db07fa3；model：gpt-5.6-sol；reasoning：high

## review

- 状态：recorded
- 摘要：fresh primary Review 对 production subject 14f110c..ed44a889：Standards PASS / Spec PASS / 0 findings。post-review test-only commit ad0f15f 经 fresh focused re-review VERIFIED；最终无 open finding。
- 证据来源：.local/workflow-state/HARNESS-004-review.md；.local/workflow-state/HARNESS-004-focused-review.md
- session：44759952-61dd-44b5-b28c-a8e5bf9f7696；run：1e298451-5bed-49f7-a1f4-2b5de013bb05；model：gpt-5.6-sol；reasoning：high
- session：362108fc-3f65-4074-aa2c-80724568f909；run：b6ccb966-b894-42dd-a72a-00621e111223；model：gpt-5.6-sol；reasoning：medium

## acceptance

- 状态：recorded
- 摘要：Emilia deterministic Acceptance 5/5 AC PASS；未启动 Acceptance Agent。最终 \#44 相关 gate/Harness、bridge、computer、shutdown、text/workflow-protection、typecheck、diff-check 均通过。full suite 的 4 个剩余失败已分类为票外前置问题。
- 证据来源：.local/workflow-state/HARNESS-004-acceptance.md
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：可核验模型 usage 下界：input 8,262,973；cached input 7,928,960；output 68,895。范围包括成功 design、成功 implementation、primary Review、focused re-review；另有一条 stopped design 与一条 stopped implementation 未暴露 usage，真实总量更高，故 cost anomaly=true。raw usage 仅作工程诊断，不等同产品额度 1:1。
- 证据来源：.local/workflow-state/HARNESS-004.md

## 失败 / 重试

- 状态：recorded
- 摘要：一条 ticket-design run 因重复嵌套 PowerShell/目录扫描被 Emilia 停止；首条 implementation run 因 node\_modules junction 指向缺依赖目录而停止。首次 full suite 130/140 pass，5 个 \#44 test fixture 兼容失败经 ad0f15f 修复后转绿；最终 135/140 pass，3 个 Codex executable discovery 在默认分支 14f110c 同样失败，另 1 个 task timing 为 \#44 前已知问题。
- 证据来源：.local/workflow-state/HARNESS-004.md；.local/workflow-state/HARNESS-004-acceptance.md

## Findings 与修复

- 状态：none
- 摘要：primary Review Standards/Spec 均 0 findings；test-only focused re-review VERIFIED，最终无 open finding。
- 证据来源：.local/workflow-state/HARNESS-004-review.md；.local/workflow-state/HARNESS-004-focused-review.md

## 人工介入点

- 状态：recorded
- 摘要：Emilia 修复 0-token preflight 漏判：移除失效 node\_modules junction 并用锁定依赖离线安装；Acceptance 期间机械修正 text fixture healthy gate，不修改 production。Review 全程单 reviewer 串行/聚焦，没有并行模型线。
- 证据来源：.local/workflow-state/HARNESS-004.md

## PR

- 状态：pending
- 摘要：尚未创建 PR。
- 证据来源：unknown / 尚无来源

## Merge

- 状态：pending
- 摘要：尚未合并。
- 证据来源：unknown / 尚无来源

## Raw evidence（仅引用）

- implementation-handoff：available
  - 本机位置：docs/implementation-notes/HARNESS-004.md
  - 观察时间：2026-09-20T00:26:46.400Z；适用内容 / 来源身份：production implementation commit ed44a8897f2ac040b63d0c9830c20ed421da302a

- checkpoint：available
  - 本机位置：.local/workflow-state/HARNESS-004.md
  - 观察时间：2026-09-20T00:26:46.400Z；适用内容 / 来源身份：final pre-delivery checkpoint at ad0f15f3f2ca14a5bfff82f4ff62d2a8dcac2f70

- primary-review：available
  - 本机位置：.local/workflow-state/HARNESS-004-review.md
  - 观察时间：2026-09-20T00:26:46.400Z；适用内容 / 来源身份：full Review 14f110c..ed44a889; 0 findings

- focused-review：available
  - 本机位置：.local/workflow-state/HARNESS-004-focused-review.md
  - 观察时间：2026-09-20T00:26:46.400Z；适用内容 / 来源身份：focused re-review ed44a889..ad0f15f; VERIFIED

- acceptance：available
  - 本机位置：.local/workflow-state/HARNESS-004-acceptance.md
  - 观察时间：2026-09-20T00:26:46.400Z；适用内容 / 来源身份：Emilia deterministic Acceptance at ad0f15f; 5/5 AC PASS

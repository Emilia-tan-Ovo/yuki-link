# COMPANION-009-IMPL-R2 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-29T16:38:34.401Z
- Ticket / Issue：COMPANION-009-IMPL-R2 / GitHub \#134
- 来源：docs/implementation-notes/COMPANION-009-IMPL-R2.md；.local/workflow-state/COMPANION-009-IMPL-R2.md；.local/workflow-state/companion-009-primary-review-1.md；.local/workflow-state/companion-009-focused-review-1.md；.local/workflow-state/companion-009-final-acceptance.md
- worktree：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-009-implementation-v2
- branch：codex/companion-009-wechat-v2
- fixed point：16a065cd44a9fd1525a1e5336d862a4e2fe25b13
- HEAD：207b458248f8a58ecf6c4af69d76c6c2246b49a0

## 过程与结果

COMPANION-009 将真实个人微信接入现有 Desktop BackendSession 与同一 conversation.sqlite / Companion Memory；完成绑定、文字往返、持久 operation receipt、memory\_revision、真实投递证据与跨端记忆接续。Primary Review 的 ST1/S1-S5、真实 Acceptance 的 A1/A2 均已修复并 fresh focused verify。最终真实微信往返、Desktop→微信记忆召回、微信遗忘→Desktop 不再召回均通过；人格语气自然度仅记非阻塞 follow-up。

## implementation

- 状态：recorded
- 摘要：fresh Sol medium implementation 提交 722c4a2；Review finding 修复提交 cce89b6；真实 Acceptance 修复提交 96b62a4、207b458。最终工作树 clean。
- 证据来源：docs/implementation-notes/COMPANION-009-IMPL-R2.md；.local/workflow-state/COMPANION-009-IMPL-R2.md
- session：71d654c3-3fb0-43f8-8e64-0263bce944d8；run：4b1ec273-623c-477f-9dfa-584370659b16；model：gpt-6-sol；reasoning：medium
- session：219ef814-242a-4dcb-ba47-aada081041c6；run：3dd479c4-bcfe-42fe-b549-e13d0341d505；model：gpt-6-sol；reasoning：medium

## review

- 状态：recorded
- 摘要：Primary Review 用 Sol high，发现 ST1/S1-S5；repair 后 focused verify 全过。A1/A2 也分别由 fresh Sol medium focused reviewer 验证通过；最终无 open finding。
- 证据来源：.local/workflow-state/companion-009-primary-review-1.md；.local/workflow-state/companion-009-focused-review-1.md；.local/workflow-state/companion-009-real-acceptance-a1-focused-review.md；.local/workflow-state/companion-009-real-acceptance-a2-focused-review.md
- session：125f8628-2938-4942-9c65-b9e47dc02216；run：024fe4ab-ddde-43e1-89be-5c007a6c428a；model：gpt-6-sol；reasoning：high
- session：cd6441c5-68c0-4d58-b834-8ec33c84adcf；run：fe763912-ef9d-4e33-b987-ffa99d30b36e；model：gpt-6-sol；reasoning：medium
- session：f77d1bf1-3fde-4156-b59e-8f1004eb1c96；run：72289810-472b-4aab-be80-c9785b25c610；model：gpt-6-sol；reasoning：medium
- session：ad2714af-4075-49e1-8562-ee71576cfc5b；run：f76fa228-c582-407c-ba13-34980e9253bc；model：gpt-6-sol；reasoning：medium

## acceptance

- 状态：recorded
- 摘要：Emilia \+ Owner 直接做真实外部验收，无 acceptance 模型 session。真实扫码/本机确认、真实微信消息→同一 BackendSession→手机可见、Desktop 写入月桂-73→微信召回、微信 /遗忘→memoryRevision 2/cutoff 6/marker 归零→Desktop 不再回答旧事实，均有证据。
- 证据来源：.local/workflow-state/companion-009-final-acceptance.md
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：工程模型 6 个 run 合计 raw input 21,080,544、cached 20,508,160、output 102,594；另有 Astra-high 设计复审 raw input 1,119,782、cached 1,018,880、output 11,883。implementation 单 run raw input 14,781,567，是主要 cost anomaly。修复后完整 Desktop suite 198/198；A2 最终定向 27/27。
- 证据来源：.local/workflow-state/COMPANION-009-IMPL-R2.md

## 失败 / 重试

- 状态：recorded
- 摘要：Primary Review 发现 ST1、S1-S5，其中 S2 为旧 context token 可能发往新绑定账号；真实 Acceptance 又发现 A1 getupdates 可选字段误判与 A2 自然语言误路由。全部修复并由独立 focused review verified。
- 证据来源：.local/workflow-state/companion-009-primary-review-1.md；.local/workflow-state/companion-009-focused-review-1.md；.local/workflow-state/companion-009-real-acceptance-a1-focused-review.md；.local/workflow-state/companion-009-real-acceptance-a2-focused-review.md

## Findings 与修复

- 状态：recorded
- 摘要：ST1/S1-S5、A1、A2 最终均 verified；最终 subject HEAD 207b458，Acceptance passed。
- 证据来源：.local/workflow-state/companion-009-focused-review-1.md；.local/workflow-state/companion-009-real-acceptance-a1-focused-review.md；.local/workflow-state/companion-009-real-acceptance-a2-focused-review.md；.local/workflow-state/companion-009-final-acceptance.md

## 人工介入点

- 状态：recorded
- 摘要：Owner 参与真实个人微信扫码、本机确认、真机消息、读取选择码、执行 /遗忘，并提供手机/桌面可见结果。A1/A2 均由真实验收触发。人格回复偏系统化记为 Persona/Prompt 非阻塞 follow-up。
- 证据来源：.local/workflow-state/companion-009-final-acceptance.md

## PR

- 状态：pending
- 摘要：尚未创建 PR；closeout archive 生成后 push 分支并创建 PR，关联 \#134。
- 证据来源：unknown / 尚无来源

## Merge

- 状态：pending
- 摘要：尚未合并；merge 保留 Owner gate。
- 证据来源：unknown / 尚无来源

## Raw evidence（仅引用）

- checkpoint：available
  - 本机位置：.local/workflow-state/COMPANION-009-IMPL-R2.md
  - 观察时间：2026-09-29T16:38:34.401Z；适用内容 / 来源身份：final closeout checkpoint for 207b458

- implementation-notes：available
  - 本机位置：docs/implementation-notes/COMPANION-009-IMPL-R2.md
  - 观察时间：2026-09-29T16:38:34.401Z；适用内容 / 来源身份：tracked implementation \+ A1/A2 repair notes

- primary-review：available
  - 本机位置：.local/workflow-state/companion-009-primary-review-1.md
  - 观察时间：2026-09-29T16:38:34.401Z；适用内容 / 来源身份：primary review 16a065c..722c4a2

- focused-review：available
  - 本机位置：.local/workflow-state/companion-009-focused-review-1.md
  - 观察时间：2026-09-29T16:38:34.401Z；适用内容 / 来源身份：focused verification on cce89b6

- a1-review：available
  - 本机位置：.local/workflow-state/companion-009-real-acceptance-a1-focused-review.md
  - 观察时间：2026-09-29T16:38:34.401Z；适用内容 / 来源身份：A1 focused verification on 96b62a4

- a2-review：available
  - 本机位置：.local/workflow-state/companion-009-real-acceptance-a2-focused-review.md
  - 观察时间：2026-09-29T16:38:34.401Z；适用内容 / 来源身份：A2 focused verification on 207b458

- final-acceptance：available
  - 本机位置：.local/workflow-state/companion-009-final-acceptance.md
  - 观察时间：2026-09-29T16:38:34.401Z；适用内容 / 来源身份：real Owner WeChat \+ shared memory final Acceptance on 207b458

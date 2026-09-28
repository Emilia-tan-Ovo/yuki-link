# COMPANION-007 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-28T16:28:43.197Z
- Ticket / Issue：COMPANION-007 / GitHub \#132
- 来源：GitHub \#132；GitHub \#125；GitHub PR \#153；GitHub \#151；GitHub PR \#152；docs/implementation-notes/COMPANION-007.md
- worktree：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-007
- branch：codex/companion-007-continuous-to-pr
- fixed point：094b049cc733e0891af262a721370cb203c79260
- HEAD：c11b4d393131dbae923574e31fb0bbd9e2e0f780

## 过程与结果

实现并合并一次确认后在既有 Workflow / ExecutionOperations / Review / Acceptance 上连续推进到授权终点的 Companion orchestration；代表性真实链完成 \#151→PR \#152，最终 \#132 经 primary Review、集中 finding-fix、focused re-review 全部通过并由 PR \#153 合并。未执行 deploy 或 production restart。

## implementation

- 状态：recorded
- 摘要：主实现经历一次 timeout 后从 durable delta 恢复；真实 E2E 随后暴露 preparation finalize、result identity、public receipt、authenticated Issue readback、dependency readiness 与 model-launch recovery 等 seam，并在同一票内修复。最终 formal Review 的 CR-001～004 作为一个 finding batch 集中修复；focused re-review 未通过的 CR-003/004 继续原 fix session 补完。
- 证据来源：docs/implementation-notes/COMPANION-007.md；GitHub \#132
- session：7a892f32-ca25-4cbc-b395-9ec92177090a；run：b0586341-e32f-4566-abe8-66778c1f25f3；model：gpt-6-sol；reasoning：high
- session：55e9eae9-a100-4d25-ada3-f26669ee879d；run：30081117-37da-456c-930c-05f56ce2ed89；model：gpt-6-sol；reasoning：high
- session：4c03595d-ce66-4fd0-a749-7a0fca020beb；run：64867a89-d675-4d1f-a91f-9f2de519528b、e42b3c55-b1a4-403d-855f-b382dd8cc2dc；model：gpt-6-sol；reasoning：high

## review

- 状态：recorded
- 摘要：最终 fresh primary Review 给出 CR-001～004，一个集中修复批次处理。focused re-review 首轮验证 CR-001/002、保留 CR-003/004；继续原 fix session 后由同一 reviewer session 最终四项全部 VERIFIED，Standards / Spec PASS。
- 证据来源：docs/implementation-notes/COMPANION-007.md；GitHub \#132
- session：31b2c516-cc79-4e92-8690-da742e4f6426；run：9b677817-789e-4da9-ba85-30d1dcaa7aaa；model：gpt-6-sol；reasoning：high
- session：f9dd6e20-1685-410e-aca5-724fe789bd25；run：627bae2f-485c-4252-a9c5-e7b5db84681d、0d40b237-fc08-41f2-967c-4b9d67ac1c2e；model：gpt-6-sol；reasoning：high

## acceptance

- 状态：recorded
- 摘要：Representative real E2E：Owner 实际确认 candidate Desktop card 后，系统创建 \#151/worktree，运行 fresh Astra-high design、fresh Sol-high implementation、机械 full-suite/commit、fresh Review、deterministic Acceptance，并交付 PR \#152；continuation endpoint-reached。最终 \#132 full validation 与 focused re-review 均通过。Acceptance 无单独模型 session。
- 证据来源：docs/implementation-notes/COMPANION-007.md；GitHub \#151；GitHub PR \#152
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：未生成整票完整 token 总和：首个 timed-out implementation run usage 不可得，保持 unknown。最终 primary Review fix run 64867… input 5.02M/cached 4.91M，继续同 repair session 的 run e42b… input 6.45M/cached 6.32M，属于明显成本异常；最终 focused re-review run 0d40… input 0.895M/cached 0.740M。
- 证据来源：docs/implementation-notes/COMPANION-007.md

## 失败 / 重试

- 状态：recorded
- 摘要：主要失败/重试：首个 implementation 30m timeout；真实 E2E 连续暴露多个集成 seam；candidate restart 遇 stale runtime lock；fresh worktree 首次 full-suite 因 Desktop dependency 未准备失败；模型提前 Git commit 造成 frozen subject drift；owned task request 过期后用新 retry request 重跑同一机械验证；PR push/旧 sibling commit 通过 exact lease 与 immutable identity 对账收敛。最终无未解决测试失败。
- 证据来源：docs/implementation-notes/COMPANION-007.md；GitHub PR \#152；GitHub PR \#153

## Findings 与修复

- 状态：recorded
- 摘要：最终 primary Review：CR-001 Review isolation durable evidence、CR-002 full-suite→commit 字节绑定、CR-003 reserved commit 恢复、CR-004 durable model-usage checkpoint。四项同属一个 finding batch；CR-001/002 首次 focused re-review VERIFIED，CR-003/004 继续原 fix session 后由同一 reviewer session最终 VERIFIED。
- 证据来源：docs/implementation-notes/COMPANION-007.md；GitHub \#132

## 人工介入点

- 状态：recorded
- 摘要：Owner 实际完成 candidate card 的一次确认，并多次要求暂停/继续；Owner 手工合并代表性 PR \#152 与主票 PR \#153。Emilia 进行了 deterministic dependency preparation、candidate restart/reconcile、机械 task receipt 收敛与 exact-lease push；未替 Owner 执行 deploy 或 production restart。
- 证据来源：GitHub PR \#152；GitHub PR \#153；docs/implementation-notes/COMPANION-007.md

## PR

- 状态：recorded
- 摘要：主票 PR \#153 已创建并由 Owner 合并；head c11b4d393131dbae923574e31fb0bbd9e2e0f780，base codex/codex-session-bridge。代表性 E2E PR \#152 也已合并。
- 证据来源：GitHub PR \#153；GitHub PR \#152

## Merge

- 状态：recorded
- 摘要：PR \#153 于 2026-09-28T16:20:26Z 合并，merge commit 989b846f0b807104a223ed8ba8f2bf68e084353d；\#132 随后关闭。远端默认分支已回读为该 merge commit。
- 证据来源：GitHub PR \#153；GitHub \#132

## Raw evidence（仅引用）

- implementation-notes：available
  - 本机位置：docs/implementation-notes/COMPANION-007.md
  - 观察时间：2026-09-28T16:28:43.197Z；适用内容 / 来源身份：merged baseline 989b846 contains final implementation, E2E, review and validation evidence

- checkpoint：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-007\\.local\\workflow-state\\COMPANION-007.md
  - 观察时间：2026-09-28T16:28:43.197Z；适用内容 / 来源身份：historical local COMPANION-007 checkpoint; final pre-merge branch HEAD c11b4d3

- e2e-root-pointer：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-007\\.local\\workflow-state\\COMPANION-007-e2e-root.txt
  - 观察时间：2026-09-28T16:28:43.197Z；适用内容 / 来源身份：historical pointer to isolated representative E2E runtime for card/Issue \#151/PR \#152

# HARNESS-012 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-21T07:10:57.310Z
- Ticket / Issue：HARNESS-012 / GitHub \#76
- 来源：docs/implementation-notes/HARNESS-012.md；docs/specs/yuki-harness-v0.md；docs/design/yuki-harness-v0-handoff.md；GitHub \#76 / PR \#77
- worktree：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012
- branch：codex/harness-012-ui-productization
- fixed point：ea34e26f18ee89aa96401b8f57c43fd8527d8e16
- HEAD：19a8ca7c97ac2e47f89b85e33df0fab600716e99

## 过程与结果

HARNESS-012 将 Owner 已确认的 Conversation-first prototype 产品化为同源 React/TypeScript Harness 工作台，接入真实 Project/Ticket/Conversation/Workflow/Changes、稳定分页与安全按文件 Diff，并保留 Provider-neutral 与只读 Composer seam。Primary Review 的 2 个 P2 finding 均经 fresh 修复与 focused Review verified；真实 Chrome Acceptance 7/7 通过。PR \#77 已由 Owner 合并为 f875b358，\#76 自动关闭。resident 7391/7394 尚未更新到该 merge，不把 merge 说成生产部署。

## implementation

- 状态：recorded
- 摘要：fresh Astra high 完成 44-file UI 产品化纵向实现；后续 fresh Astra fix session 修正 full-suite 旧断言、binary patch 状态/边界与 finding Review 身份。最终产品 subject 为 19a8ca7；最终 YCA suite 184 total / 183 pass / 0 fail / 1 opt-in skip，Control Center 51/51。
- 证据来源：docs/implementation-notes/HARNESS-012.md；.local/workflow-state/HARNESS-012.md；.local/workflow-state/HARNESS-012-acceptance.md
- session：cc01709a-403a-4975-94b7-053a8a283e45；run：446bc246-7b70-4d00-9ce9-cbc83df180d6；model：gpt-6-astra；reasoning：high
- session：47353d61-2b9b-4600-ba3b-4ead975b983d；run：53fae0bd-1351-4aa4-bc8a-d58cfaf25a96；model：gpt-6-astra；reasoning：low
- session：4fb1054a-bfd8-4fbb-838b-b0dfb56ae136；run：eecb398e-e487-4d27-a3c1-9ef34aa784d9；model：gpt-6-astra；reasoning：medium
- session：fa3dedcc-02d3-49d0-811b-edd49c2577e9；run：55f92a17-1962-4445-9463-2b01d18a4552；model：gpt-6-astra；reasoning：low

## review

- 状态：recorded
- 摘要：fresh Astra high Primary Review：Standards 0 findings，Spec 报告 2 个 P2。首轮 focused Review 验证 SPEC-002 并继续暴露 SPEC-001 的 CR/U\+2028/U\+2029 边界误判；最终 fresh focused Review 对 19a8ca7 判定 passed，SPEC-001/002 均 verified，无 subject drift。
- 证据来源：.local/workflow-state/HARNESS-012-review.md；.local/workflow-state/HARNESS-012-focused-review.md；.local/workflow-state/HARNESS-012-focused-review-final.md
- session：a407fbdb-c6c9-46dd-b055-f34628714b1a；run：0360f3e2-9eb1-46c5-8938-517afbcdc23e；model：gpt-6-astra；reasoning：high
- session：b662ad9f-9785-47fb-99ae-5161a78a1940；run：7600c9ba-5ffa-4c3d-b6bd-02d5b604e72f；model：gpt-6-astra；reasoning：medium
- session：89d9acd6-db56-4c02-9846-0fd03164159a；run：a4ad549e-33e8-47e5-a166-a9768c15942b；model：gpt-6-astra；reasoning：low

## acceptance

- 状态：recorded
- 摘要：Emilia deterministic real-browser Acceptance，无 Acceptance 模型 session。final production build \+ 真实 HARNESS-012 runtime snapshot 在 Chrome 中验证三栏、Review/Focused Review、真实分页锚点、62 个 unknown 中的实际 fallback、Split/Unified Diff、长行 0px overflow、1100/800/600 响应式、CSP/Console/Network；7/7 pass。Workflow revision 8 applicability verified。
- 证据来源：.local/workflow-state/HARNESS-012-acceptance.md；.local/workflow-state/HARNESS-012.md
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：已明确记录的 8 条模型 run 累计 raw input 13,044,676、cached input 12,324,608、output 111,433；仅作工程诊断，不等同订阅额度。范围包含 ticket-design、main implementation、两次 finding fix 与三轮 Review；产品化前只读调研/收敛等未完整计数，故不外推为整票总量。
- 证据来源：.local/workflow-state/HARNESS-012.md

## 失败 / 重试

- 状态：recorded
- 摘要：实现后 full suite 先暴露 2 个 shutdown 旧断言，按新 SPA/read-only GET 语义最小修复；Control Center 真实 deployment 因新增 UI build 超过旧 90s 测试预算并在宿主负载下触发 executable probe ETIMEDOUT，最终只调整测试 timeout/串行/有界重试，不放宽 production discovery。Primary Review 另发现 2 个 P2，首轮 binary 修复又被 focused Review 抓到正文边界误判，均最终 verified。
- 证据来源：docs/implementation-notes/HARNESS-012.md；.local/workflow-state/HARNESS-012-review.md；.local/workflow-state/HARNESS-012-focused-review-final.md

## Findings 与修复

- 状态：recorded
- 摘要：HARNESS-012-SPEC-001：Git binary marker 误报 available，首修后又发现 CR/U\+2028/U\+2029 false-positive；最终按 LF record boundary 修复并 verified。HARNESS-012-SPEC-002：finding DTO 丢失 origin Review 导致同名 finding UI identity 冲突；补 origin\_review\_id/composite key 后 verified。最终 focused Review passed，无 open finding。
- 证据来源：.local/workflow-state/HARNESS-012-review.md；.local/workflow-state/HARNESS-012-focused-review-final.md

## 人工介入点

- 状态：recorded
- 摘要：Owner 在 implementation 启动前纠正模型路由，明确本票前端实现使用 Astra；Emilia 后续将 implementation/fix/review 全部按 Astra 路线执行。Owner 最终手动 merge PR \#77。浏览器 Acceptance 中 Emilia 自行恢复独立 yuki-windows tunnel 并完成桌面/CDP 验收，未要求 Owner 充当测试员。
- 证据来源：.local/workflow-state/HARNESS-012.md；.local/workflow-state/HARNESS-012-merge.md；.local/workflow-state/HARNESS-012-acceptance.md

## PR

- 状态：recorded
- 摘要：PR \#77：HARNESS-012：Conversation-first UI 产品化；head codex/harness-012-ui-productization → base codex/codex-session-bridge，5 commits，创建后 merge state CLEAN，Closes \#76 正确识别；GitHub 未配置分支 checks。
- 证据来源：GitHub PR \#77；.local/workflow-state/HARNESS-012-merge.md

## Merge

- 状态：recorded
- 摘要：Owner 于 2026-09-21T07:06:33Z 合并 PR \#77；merge commit f875b358faa3491baa7dc550e4921839f602ac0b。\#76 于 07:06:34Z 自动关闭；fetch 后远端默认分支 HEAD 与 merge commit 一致。resident YCA/Harness 尚未 rollout 本 merge。
- 证据来源：GitHub PR \#77；GitHub \#76；.local/workflow-state/HARNESS-012-merge.md

## Raw evidence（仅引用）

- implementation-notes：available
  - 本机位置：docs/implementation-notes/HARNESS-012.md
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：tracked implementation/design handoff present in merged default branch

- checkpoint：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012\\.local\\workflow-state\\HARNESS-012.md
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：closeout checkpoint; Workflow revision 8 applicability verified before merge

- primary-review：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012\\.local\\workflow-state\\HARNESS-012-review.md
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：fresh full Review for b377800; Standards passed, two P2 Spec findings

- final-focused-review：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012\\.local\\workflow-state\\HARNESS-012-focused-review-final.md
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：fresh final focused Review passed for subject 19a8ca7; SPEC-001/002 verified

- acceptance-report：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012\\.local\\workflow-state\\HARNESS-012-acceptance.md
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：deterministic real Chrome Acceptance 7/7 passed for subject 19a8ca7

- desktop-screenshot：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012\\.local\\workflow-state\\HARNESS-012-browser-desktop.png
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：real production browser desktop screenshot; SHA-256 357b421e88ab34f8c03a9cd545c3e62b921d932f0e9331607ac90d6f1771b886

- mobile-screenshot：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012\\.local\\workflow-state\\HARNESS-012-browser-mobile.png
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：real production browser 600px screenshot; SHA-256 1335dfb51705f759dc418ef75d20e458485d33bb5333c288dad90ef77f905b4a

- merge-receipt：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-012\\.local\\workflow-state\\HARNESS-012-merge.md
  - 观察时间：2026-09-21T07:10:57.310Z；适用内容 / 来源身份：PR \#77 merged; issue \#76 closed; merge/default HEAD f875b358

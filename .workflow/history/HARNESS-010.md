# HARNESS-010 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-20T12:32:27.441Z
- Ticket / Issue：HARNESS-010 / GitHub \#50
- 来源：.local/HARNESS-010-ticket.md；docs/implementation-notes/HARNESS-010.md；.local/workflow-state/HARNESS-010.md；.local/workflow-state/HARNESS-010-review.md；.local/workflow-state/HARNESS-010-focused-review.md；.local/workflow-state/HARNESS-010-acceptance.md
- worktree：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\harness-010
- branch：codex/yuki-harness-v0-010
- fixed point：49fb936451d681449f6d00a70ff048ba393021d6
- HEAD：67d26ccde62a4470ab4b2b75c6a42fc7f0a6521f

## 过程与结果

HARNESS-010 为既有 Control Center→YCA→Harness 单拓扑增加 Windows 冷启动 desired-state reconciliation、可选 harnessPort 与只读 recovery observation；Primary Review 的 observeOnly、事件重载、有界 recovery 投影和文档 finding 已修复并由 focused re-review 全部 verified。真实 Windows 注销→登录 Acceptance 5/5 通过。验收后的跨时代回滚到 pre-Harness 旧 YCA release 暴露 optional CLI 向后兼容边界，未影响已完成 Acceptance；生产已恢复到默认分支 release 49fb936，YCA/tunnel healthy。PR/merge 尚未发生。

## implementation

- 状态：recorded
- 摘要：ticket-design 确认复用唯一 Supervisor/YCA 拓扑；fresh implementation 完成 harnessPort、YCA cold reconciliation 与 Harness recovery observation。Primary Review findings 由 fresh finding-fix session 最小修复，定向 Supervisor 28/28、Harness 8/8、typecheck/syntax/diff-check 通过。
- 证据来源：docs/implementation-notes/HARNESS-010.md；.local/workflow-state/HARNESS-010.md
- session：5bb643c3-6ef5-4c64-87fd-ca3cfea78f4b；run：eba0d623-24c4-4252-bb00-397e1648e933；model：gpt-5.6-sol；reasoning：medium
- session：04a42594-9e55-4b6b-a8d4-1629da552690；run：9d2d9a7e-0960-4e1e-b54c-a2de4d60e83e；model：gpt-5.6-sol；reasoning：medium

## review

- 状态：recorded
- 摘要：fresh FULL Review 对 frozen implementation subject 给出 1 High \+ 3 Medium finding；fresh focused re-review 对 7-file fix subject 逐项复核，STD-001/002/003 与 SPEC-001/002/003 全部 verified，subject helper 最终 matched，无新增高风险范围。
- 证据来源：.local/workflow-state/HARNESS-010-review.md；.local/workflow-state/HARNESS-010-focused-review.md
- session：89b2305e-164c-423b-993d-f9c0545ca769；run：102138e1-3545-4b54-b39c-d75e8fc7ad2b；model：gpt-5.6-sol；reasoning：high
- session：4bb6dbc1-bd02-4e7c-a142-7ec954bc9301；run：2da00c0e-291a-4510-9d66-3754e1154441；model：gpt-5.6-sol；reasoning：medium

## acceptance

- 状态：recorded
- 摘要：Emilia\+YCA deterministic Acceptance 5/5；包含真实 Windows 注销→登录。UI 未打开时 Control Center/YCA/Harness 自动恢复，7394=HTTP 200；Bridge 计数保持 122 sessions / 190 runs / 190 requests / 0 active run；tunnel 在取证前保持 stopped；两次重开 Harness UI 后 journal source\_id/cursor/record count 不变。无 acceptance 模型 session。
- 证据来源：.local/workflow-state/HARNESS-010-acceptance.md；C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\control-center\\h010-acceptance\\evidence\\after-before-tunnel.json；C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\control-center\\h010-acceptance\\evidence\\after-tunnel.json
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：已知完成模型运行 5 条：ticket-design、implementation、FULL Review、finding-fix、focused re-review；累计 raw input 9,720,662，cached input 9,158,016，output 74,221。该 raw token 统计不等同于订阅周额度。Control Center full suite 47 total / 46 pass / 1 executable-discovery ETIMEDOUT，失败项隔离 1/1 pass；Bridge full suite 173 total / 172 pass / 0 fail / 1 既有 opt-in skip。
- 证据来源：.local/workflow-state/HARNESS-010.md；.local/workflow-state/HARNESS-010-review.md；.local/workflow-state/HARNESS-010-focused-review.md

## 失败 / 重试

- 状态：recorded
- 摘要：Primary Review 发现 observeOnly 冷启动副作用、startup event 重载丢失、recovery.observed 无界投影、README 旧语义，均已修复并 verified。Control Center full suite 的 executable discovery ETIMEDOUT 隔离复跑通过。真实登录 Acceptance 完成后，回滚到 pre-Harness YCA release 1636cb69 时旧 CLI 不认识较新 optional Harness 参数，YCA exit 1/STARTUP\_TIMEOUT；生产随后通过现有 update/restart 恢复到 49fb936。该回滚兼容边界早于 HARNESS-010，不作为本票 Acceptance 失败。
- 证据来源：.local/workflow-state/HARNESS-010-review.md；.local/workflow-state/HARNESS-010-focused-review.md；.local/workflow-state/HARNESS-010-acceptance.md；.local/workflow-state/HARNESS-010-production-recovery.md；C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\control-center\\h010-acceptance\\evidence\\rollback-error.json

## Findings 与修复

- 状态：recorded
- 摘要：STD-001/SPEC-001 observeOnly bypass：fixed\+verified；STD-002/SPEC-002 startup event reload：fixed\+verified；SPEC-003 bounded recovery projection：fixed\+verified；STD-003 README semantics：fixed\+verified。focused re-review 无新增 finding。
- 证据来源：.local/workflow-state/HARNESS-010-review.md；.local/workflow-state/HARNESS-010-focused-review.md

## 人工介入点

- 状态：recorded
- 摘要：Owner 明确批准真实 Windows 登录验收并人工登录回系统；Acceptance probe 只在冷启动证据落盘后显式启动 tunnel。验收后旧 release 回滚失败，Owner 通过 Control Center 执行更新并重启 YCA，再恢复 tunnel；最终生产 YCA/tunnel healthy，两个临时 Scheduled Task 均不存在。
- 证据来源：.local/workflow-state/HARNESS-010-acceptance.md；.local/workflow-state/HARNESS-010-production-recovery.md

## PR

- 状态：pending
- 摘要：HARNESS-010 尚未创建 PR；closeout archive 生成后将推送 codex/yuki-harness-v0-010 并创建 Closes \#50 的 PR。
- 证据来源：unknown / 尚无来源

## Merge

- 状态：pending
- 摘要：尚未合并；Owner 保留 merge gate。
- 证据来源：unknown / 尚无来源

## Raw evidence（仅引用）

- implementation-notes：available
  - 本机位置：docs/implementation-notes/HARNESS-010.md
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：HARNESS-010 design/implementation/finding-fix handoff; current tracked bytes at HEAD 67d26cc

- primary-review：available
  - 本机位置：.local/workflow-state/HARNESS-010-review.md
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：FULL Review report for subject HEAD 5247ec3 / digest 1064454e...

- focused-review：available
  - 本机位置：.local/workflow-state/HARNESS-010-focused-review.md
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：focused re-review for fix HEAD 67d26cc / digest aba10a0c...; conclusion verified

- acceptance-report：available
  - 本机位置：.local/workflow-state/HARNESS-010-acceptance.md
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：deterministic \+ real Windows logon Acceptance; result passed 5/5; includes rollback incident note

- real-login-pre-tunnel：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\control-center\\h010-acceptance\\evidence\\after-before-tunnel.json
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：real logon evidence before explicit tunnel start: CC/YCA/Harness up; counts unchanged; tunnel stopped

- real-login-post-tunnel：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\control-center\\h010-acceptance\\evidence\\after-tunnel.json
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：one-shot explicit tunnel start receipt after acceptance evidence capture

- rollback-error：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\control-center\\h010-acceptance\\evidence\\rollback-error.json
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：post-Acceptance rollback incident: HTTP 409 while restoring incompatible old release

- production-recovery：available
  - 本机位置：.local/workflow-state/HARNESS-010-production-recovery.md
  - 观察时间：2026-09-20T12:32:27.441Z；适用内容 / 来源身份：production recovery receipt: default release 49fb936, YCA/tunnel healthy, temp tasks absent

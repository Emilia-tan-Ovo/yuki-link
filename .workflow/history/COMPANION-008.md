# COMPANION-008 — Closeout archive

> 冻结历史摘要，不是动态 runtime source of truth。本机 raw 位置不保证在 fresh clone 可用；available 只表示观察时本机文件存在，不代表内容有效或验收通过。

- 观察时间：2026-09-29T13:28:59.456Z
- Ticket / Issue：COMPANION-008 / GitHub \#133
- 来源：GitHub \#133；GitHub \#125；GitHub PR \#159；GitHub PR \#160；GitHub PR \#161；GitHub PR \#162；GitHub PR \#163；GitHub PR \#164；docs/implementation-notes/COMPANION-008.md
- worktree：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-008
- branch：codex/companion-008-control-resume
- fixed point：77bafe809e2f4ae4557796624616af14550c34a2
- HEAD：de40012cbb9718672adf7f5c590996f9cc569a8f

## 过程与结果

实现工程状态查询、精确停止、停止意图持久化与断线后原工作定位；F1-F5 经 focused review 全部 VERIFIED。PR \#159 合并后，production 验证暴露 MCP discovery、Tunnel loopback proxy、legacy fallback、Tunnel 版本与 Harness 同步扫描阻塞等基础设施问题，已由 PR \#160-\#164 收敛。production 当前运行 a5309fb5，主 /mcp 40 项与专用 /companion-mcp 8 项均可发现，Companion card store 已初始化到 schema v5。由于 production 卡库当前 0 张卡，没有为了验收新造模型工作，故真实 status→stop→status 终态链未执行，不宣称该子项通过。

## implementation

- 状态：recorded
- 摘要：COMPANION-008 主实现及 finding-fix 已完成；卡库迁移到 v5，新增 stop intent/target attempt、准入 guard、工程状态投影、精确 run/task stop、Desktop 重连刷新与控制 UI。定向 bridge/Desktop 测试、typecheck/check 与 diff check 均有通过记录。
- 证据来源：docs/implementation-notes/COMPANION-008.md；GitHub PR \#159
- session / run：未记录；阶段状态 recorded，不推断已执行。

## review

- 状态：recorded
- 摘要：Primary Review 后形成 F1-stop-final-guard、F2-preparation-unknown、F3-stop-journal、F4-owned-task-operation、F5-work-item-generation；两轮 focused review 后 F1-F5 全部 VERIFIED，最终受审内容对应 PR \#159 head de40012c。
- 证据来源：docs/implementation-notes/COMPANION-008.md；C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-008\\.local\\workflow-state\\COMPANION-008.md
- session：6a09782b-090f-4bc9-8571-1e825f9371b8；run：2b862382-84a3-4a5a-8f59-e9fcc12ffd38；model：gpt-6-sol；reasoning：medium

## acceptance

- 状态：recorded
- 摘要：确定性 fixture/控制契约验收已记录；合并部署后验证 production YCA 运行 a5309fb5、主 /mcp 保持 40 项、/companion-mcp 正确暴露 8 项，且 --companion-card-store 生效、真实 Desktop 卡库已初始化为 schema v5。\#133 原计划的一条真实已接收工作断线重连 \+ stop accepted \+ terminal 区分未执行，因为 production 卡库为 0 张卡；没有为打勾新建模型任务或伪造停止目标。
- 证据来源：docs/implementation-notes/COMPANION-008.md；GitHub \#133；.local/closeout/COMPANION-008-production-smoke.txt
- session / run：未记录；阶段状态 recorded，不推断已执行。

## 代表性耗时 / 调用及口径

- 状态：recorded
- 摘要：checkpoint 可核验的已观察模型用量子集：prior 6 runs input 30,061,368 / cached 29,361,408 / output 103,034；focused round 2 input 1,294,096 / cached 1,141,632 / output 9,592。合计已观察 input 31,355,464 / cached 30,503,040 / output 112,626；checkpoint 标记 anomaly=true。不是整票完整计费统计。
- 证据来源：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-008\\.local\\workflow-state\\COMPANION-008.md

## 失败 / 重试

- 状态：recorded
- 摘要：production 收尾先后遇到 ChatGPT legacy MCP discovery 兼容、Tunnel 本机 127.0.0.1 误走 HTTP\_PROXY、legacy fallback 状态、受管 Tunnel 版本以及 Harness 每秒同步 Git 扫描阻塞 Node HTTP 事件循环。分别由 PR \#160/\#161/\#162/\#163/\#164 修复；最后根因测得 workflow 扫描约 5.5s，修复后负载下普通 GET 与 MCP probe 恢复快速响应。另发现 closeout 前 Control Center 未配置 companionCardStore，已指向真实 Desktop 数据目录并重启，production 启动参数现已包含该路径。
- 证据来源：GitHub PR \#160；GitHub PR \#161；GitHub PR \#162；GitHub PR \#163；GitHub PR \#164；.local/closeout/COMPANION-008-production-smoke.txt

## Findings 与修复

- 状态：recorded
- 摘要：F1-stop-final-guard VERIFIED；F2-preparation-unknown VERIFIED；F3-stop-journal VERIFIED；F4-owned-task-operation VERIFIED；F5-work-item-generation VERIFIED。没有遗留 code-review finding。真实 production stop 终态链因没有现成 production card 未观察，不把“未观察”改写为 finding 已验证。
- 证据来源：docs/implementation-notes/COMPANION-008.md；C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-008\\.local\\workflow-state\\COMPANION-008.md

## 人工介入点

- 状态：recorded
- 摘要：Owner 合并 PR \#159，并在 production 收尾期间多次要求严格 stop-expansion。Emilia 通过确定性工具定位并处理 deployment/tunnel 基础设施 blocker，最终补齐 Control Center 的 companionCardStore 指向并受控重启 YCA；没有为验收额外启动模型工作。
- 证据来源：GitHub PR \#159；GitHub PR \#160；GitHub PR \#161；GitHub PR \#162；GitHub PR \#163；GitHub PR \#164；.local/closeout/COMPANION-008-production-smoke.txt

## PR

- 状态：recorded
- 摘要：主票 PR \#159 已合并；head de40012cbb9718672adf7f5c590996f9cc569a8f，base codex/codex-session-bridge。
- 证据来源：GitHub PR \#159

## Merge

- 状态：recorded
- 摘要：PR \#159 于 2026-09-29T09:02:37Z 合并，merge commit f8d79125cc20d8229ea84e6b9bb6cfe54aa11b9c；\#133 随后关闭。production 后续基础设施修复最终推进默认分支到 a5309fb5aeaac92975bff9809bd6990207a67445。
- 证据来源：GitHub PR \#159；GitHub \#133；GitHub PR \#164

## Raw evidence（仅引用）

- implementation-notes：available
  - 本机位置：docs/implementation-notes/COMPANION-008.md
  - 观察时间：2026-09-29T13:28:59.456Z；适用内容 / 来源身份：merged COMPANION-008 implementation/review handoff; PR \#159 head de40012c

- checkpoint：available
  - 本机位置：C:\\Users\\KQ\_Sh\\Desktop\\yuki-link\\.local\\worktrees\\companion-008\\.local\\workflow-state\\COMPANION-008.md
  - 观察时间：2026-09-29T13:28:59.456Z；适用内容 / 来源身份：historical pre-PR checkpoint; stale for delivery/production facts but valid for focused-review evidence and model usage

- production-smoke：available
  - 本机位置：.local/closeout/COMPANION-008-production-smoke.txt
  - 观察时间：2026-09-29T13:28:59.456Z；适用内容 / 来源身份：production a5309fb5 surface/config/card-store initialization observation; no live production card existed

# HARNESS-003 · Implementation Handoff

- 来源：[Ticket #43 / 最终 Implementation Notes](https://github.com/Emilia-tan-Ovo/yuki-link/issues/43)、[Source Spec](../specs/yuki-harness-v0.md)、[#42 共享底座交接](HARNESS-002.md)。
- 身份：worktree `.local/yuki-harness-v0-003`，分支 `codex/yuki-harness-v0-003`；fixed point / 实现前 HEAD：`f513aa55d7596d180770a17a764cca03e45b03a7`。
- 本轮复用原设计会话进入实现，没有重做 ticket-design。**review_policy: delegated**；接收方 **Emilia / engineering-workflow**，停止点为 fresh primary Review 前。未自行 Review，不作零 finding 或 Acceptance 声明。

## 实际交付

现有 task_start 增加顶层可选 ticket_id；归属在受理时固定，加入同 epoch/request_id 幂等身份。旧调用、20 个工具数量、任务预算和进程控制语义保留；不同 Ticket 或有/无归属切换的相同 request 拒绝且不重复执行。脚本只用于执行，新增来源投影不提供完整脚本，长期记录显式 source-not-provided。

OwnedTasks/TaskOutput 增加真实生命周期与不可变公开行的只读 observer seam。任务元数据、accepted/spawn、两流输出、错误、停止请求/尝试/结果、root exit、管道关闭和终态进入原 Harness journal；不依赖 UI 在线、不创建第二套 durable queue。来源 output seq 保持原始发布顺序，生命周期另有序号；不宣称跨流 OS 写入顺序。

TaskCollector 从已提交记录重建去重与进度，source/epoch/task 身份不会随重启换绑。扫描补齐仍保留的公开行与当前 snapshot；未保存且不可重建的生命周期留缺口。源过期、epoch 变化、采集失败、保存失败及脱敏/截断分开呈现；历史终态与实时观察分开，旧任务缺终态时保持 unknown。保存失败不拒绝新 task_start、不改写真实已受理事实、不强杀或重放任务。

## 与 #42 的实际兼容调整及写集

复用 #42 的 protectedCopy、journal record union、分来源 health/detail 与多来源 shutdown/single-writer 契约。main 仅注入 computer.tasks，**没有重新改写 shutdown，也没有修改 manager、journal、computer-calls、content-policy 或 ComputerTools**。不回改同步调用语义；其 schema 测试仅去掉“task_start 永远没有 ticket_id”的过期假设，仍核对原 8 个同步工具。

路径除本文件外相对 `tools/codex-session-bridge/`，共 16 个文件：

- 新增：`src/harness/task-model.ts`、`task-source.ts`、`task-collector.ts`；`test/harness-tasks.test.ts`。
- 修改：`src/computer/tasks.js`、`task-output.js`；`src/harness/model.ts`、`harness.ts`、`runtime.ts`、`server.ts`；`src/mcp.js`、`main.js`。
- 测试/文档：`test/harness-computer.test.ts`、`test/shutdown.test.js`、`README.md`、本 handoff。

旧 Notes 的 task 专属模块命名仍适用；来源通过 TaskSource 读取 JS 的 identities/observation/output 并订阅通知，无需改造已有 Codex Source。新的 owned_task journal 分支不伪造 session/run 身份，保留旧 v1 record 类型读取。停止和执行仍由 OwnedTasks/ComputerTask 负责。

## 测试与证据

环境：Node `v24.18.1`、npm `11.16.0`；依赖按已有 lockfile 执行 `npm ci --offline --ignore-scripts`，exit 0，无依赖变更。命令在 bridge 包内运行，日志位于本 worktree ignored `.local/workflow-state/`。

| 验证 | 实际结果 |
| --- | --- |
| 首个公开 MCP→Owned Task→Ticket 红测 | 1 failed，exit 1；公开 task_start 拒绝 ticket_id，符合缺能力预期。日志 HARNESS-003-red.log |
| 同一 primary seam 转绿 | 1/1 pass，exit 0。日志 HARNESS-003-green.log |
| 完整性/重读缺口补充 | 初次 5 pass / 1 fail（重复刷新重复写采集缺口）；修复按来源状态去重后 6/6 pass。HARNESS-003-boundaries-red.log / boundaries-green.log |
| 最终任务产品测试 `node --test test/harness-tasks.test.ts` | 6/6 pass，exit 0。HARNESS-003-tasks-final.log |
| 定向 `node --test test/harness-tasks.test.ts test/tasks.test.js test/harness-computer.test.ts test/harness.test.ts test/shutdown.test.js` | 43 pass / 1 fail，exit 1；唯一失败为沙箱内真实 taskkill 未确认，详见下文。HARNESS-003-targeted.log |
| 隔离生产 shutdown 沙箱外复核 | 1/1 pass，exit 0；锁释放时同步调用结果与 Owned Task final/输出均已保存。HARNESS-003-shutdown-recheck.log |
| strict `npm run typecheck`（最终） | exit 0。HARNESS-003-typecheck.log |
| `npm test`（完整 bridge suite，唯一一次，沙箱外） | **121 tests：119 passed、1 failed、1 skipped，exit 1**，约 63 秒。HARNESS-003-bridge-final.log |
| 全套唯一失败的定向复核 | `node --test --test-name-pattern 'catalog refresh and successive session launches' test/codex-executable.test.js`，1/1 pass，exit 0。HARNESS-003-discovery-recheck.log |
| 无 runtime 的真实 schema probe | toolSummary 成功，20 工具；sha256 `ed34bd3cb1b2abe33b6c72afdfb743d8accf8454f05037165fd34468bc5066b3`。HARNESS-003-schema-probe.log |

首个产品测试使用真实 MCP register/start/output/status/stop、真实 Journal 与 HTTP 页面，只有 OS 子进程/时钟使用既有可控 seam；不调用模型。覆盖 UI 未连接时双流/短暂停止状态、相同请求找回、正文去重、主 Conversation、HTML 转义及 Harness 重建。补充覆盖 Ticket 冲突/旧调用、半行与 UTF-8/token 跨块、来源截断、源过期/new epoch（含未保存终态）、一次采集失败/保存失败。没有复制原 task 的进程矩阵或增加验收模型。

完整 suite 唯一失败是既有 executable-discovery 夹具的 `CAPABILITY_UNAVAILABLE / discovery_status=ETIMEDOUT`，与 #42 交接记录一致；单独复核通过。未修改该模块或环境，未重跑完整 suite。唯一 skip 是原有 opt-in 本机 Skill 读取。**不能将本次全套表述为全绿。**

首次定向 shutdown 在沙箱内 taskkill 返回 STOP_FAILED，任务记录如实保留 running/null exit、stop.result failed/cleanup.unconfirmed，原 writer 未释放。获准沙箱外仅复核该测试后通过；完整 suite 中全部 3 条 shutdown 也通过。不为测试修改进程停止或系统配置。Control Center/Supervisor 未改；无 runtime schema probe 与生产 main shutdown 测试覆盖本次装配，无需另跑部署矩阵。

## 限制与交接

- Review：pending fresh primary Review；尚无专业 findings 结论。Acceptance、真实浏览器可视交互、ChatGPT→resident YCA 与日常 stable **未验证**；未部署。
- 持久副本保留来源有限预算/生命周期，不能恢复已过期或未采集的原文；来源 redacted 是任务聚合事实，不证明某条旧行是否曾被改写。best-effort 内容保护不是任意秘密识别保证。
- recording gate 仍留 #44；存储故障期间不能保证完整历史，坏 journal 按既有策略保留现场。界面当前态必须连同 source_state/observed_at 阅读，不能把历史 snapshot 当当前进程事实。
- 不涉及 #44/#45/#48/#50/#51、不部署 resident、不修改 Control Center/Supervisor；无 push/PR。
- 受测内容字节清单：`.local/workflow-state/HARNESS-003-tested-content.json`；精确 commit SHA 由提交后 checkpoint 记录。本文件与源码同批提交，避免自身 SHA 自引用。
- 提交主题：`feat: 持久记录受管任务生命周期与公开输出`。下一步由 Emilia 使用 fixed point→提交 diff、#43 Notes/Spec、规范、本 handoff 和最小测试证据启动一次 fresh primary Review；不携带完整 implementation 聊天。

## S1 fix handoff（fresh primary Review 后）

- 原受审 target：`19053b9843dceb8a69c98ca9e13137daeef0f21f`；报告：`.local/workflow-state/HARNESS-003-review.md`。原结论 Standards passed / 0 findings；Spec 仅 S1 / P2 / open，无 incomplete。
- S1 修复：在 `ComputerTask` 的 root exit 回调发布事实前，仅当管道尚未关闭且没有 termination request 时设 `status=unknown`。保留 exit_code/signal/root_state，不制造 stop requested；停止、timeout/output_limit/shutdown 分支不变，关闭管道后仍由既有 reconcile 得出终态。未改 TaskCollector 或 #44 gate。
- 窄回归使用现有 processFixture 与公开 MCP→Harness detail seam：spawn 后 `endProcess(7, false)`，核对 durable root.exit、当前快照和 task_status；随后写入晚到 stdout/stderr 并 close，核对同 task 的 failed/exit_code=7、完整公开输出且无 stop.requested。
- 红测：`node --test --test-name-pattern 'root exit 早于' test/harness-tasks.test.ts`，1 failed / exit 1，实际 running、预期 unknown；同命令修复后 1 passed / exit 0。
- 定向：`node --test test/harness-tasks.test.ts`，7/7 passed / exit 0；strict `npm run typecheck`，exit 0。日志：`.local/workflow-state/HARNESS-003-S1-{red,green,tasks,typecheck}.log`。
- 此修复不直接改变已请求 shutdown 的分支，未额外运行 shutdown；按 Owner 范围未重跑完整 bridge suite、未调查 discovery ETIMEDOUT。原未变范围的 Review/suite 证据保留，原全套 exit 1 事实不变。
- 实际 tracked 写集仅 `tools/codex-session-bridge/src/computer/tasks.js`、`tools/codex-session-bridge/test/harness-tasks.test.ts`、本 handoff。提交主题：`fix: 修正根进程退出后管道未关闭的任务状态`；精确 fix SHA 与受测文件摘要见提交后 checkpoint。
- S1：**fixed / pending focused verification**。review_policy: delegated，接收方 Emilia / engineering-workflow；下一步只针对原 S1 和修复 diff 做 fresh focused verification。本实现会话不自行 Review/Acceptance，不 push/PR/部署。

# HARNESS-002 · Implementation Handoff

- 来源：[Ticket #42 与最终 Implementation Notes](https://github.com/Emilia-tan-Ovo/yuki-link/issues/42)、[Source Spec](../specs/yuki-harness-v0.md)；[并行边界 #43](https://github.com/Emilia-tan-Ovo/yuki-link/issues/43)。两票 Notes 已于 2026-09-19 持久化并回读，本轮未重复写 Issue。
- 身份：worktree `.local/yuki-harness-v0-002`；分支 `codex/yuki-harness-v0-002`；fixed point / 实现前 HEAD 为 `4f10e2310ff517a65e18ea92b618d48637da03eb`。
- 授权：仅 #42 实现、必要测试/文档及本地 commit；**review_policy: delegated**，接收方 **Emilia / engineering-workflow**。本 session 不启动 Reviewer，终点为 fresh primary Review 前。

## 实际交付与写集

8 个现有同步工具增加顶层可选 `ticket_id`，未传时不采正文、保持旧执行返回；无新 MCP 工具，`task_start` 未增加归属参数。同步调用保存受既有规则脱敏的输入和公开结果，独立 call_id 不伪造 Codex 身份；UI/HTTP 关闭或响应丢失不会重发操作。新增独立 journal 分支沿用单 writer、flush/cursor 与旧 v1 记录读取，不迁移旧历史。

内容不增加统一 Harness 上限，保留来源截断/脱敏/缺失事实；采集失败可保存缺口，保存失败不改写实际执行结果。不同来源的采集健康分开保留。关闭顺序在电脑调用/记录收尾之后才释放 RuntimeStore 锁；无法确认停止时保留锁与只读观察。

除本文件外，路径相对 `tools/codex-session-bridge/`：

- 新增 `src/harness/computer-calls.ts`、`src/harness/content-policy.ts`、`test/harness-computer.test.ts`。
- 修改 `src/mcp.js`、`src/main.js`、`src/harness/model.ts`、`src/harness/harness.ts`、`src/harness/server.ts`。
- 修改 `test/shutdown.test.js`、`tsconfig.json`、`README.md`。

共 12 个文件，均在 Notes 预计范围（含必要 handoff）内。无需修改 `runtime.ts`、`journal.ts`、manager/store、电脑执行器、OwnedTasks 或 Control Center/Supervisor；未引入依赖变更。#42 的记录层直接在 Harness 装配，因此无需新增 runtime 参数。#43 应串行基于实际落地的 record union、computerCalls 收尾、health/detail、MCP 顶层归属与 main shutdown 契约接入，不能独立覆盖共享底座。未实现 #43 生命周期、#44 recording gate 或其他相邻票。

## 测试与证据

Node `v24.18.1`；包依赖通过 `npm ci --offline --ignore-scripts` 安装，exit 0。以下测试在 bridge 包内执行；原始日志留本 worktree `.local/workflow-state/`。

| 验证 | 实际结果 |
| --- | --- |
| 首个公开 MCP→Ticket 历史红测 | exit 1，缺保存回执；实现后转绿。`HARNESS-002-red.log` |
| `node --test test/harness-computer.test.ts`（恢复前） | 5/5 pass，exit 0；本 session 实际输出，未单独保存该次日志 |
| 关停锁释放顺序红测 | exit 1，释放锁时 result 尚未落盘。`HARNESS-002-shutdown-red.log` |
| `node --test test/shutdown.test.js`（Emilia / YCA direct） | 2/2 pass，exit 0；已回读 `HARNESS-002-shutdown-direct.log`，exit 由 Emilia 回报 |
| `node --test --test-name-pattern '采集失败' test/harness-computer.test.ts` | 新增必要故障测试 1/1 pass，exit 0。`HARNESS-002-collection.log` |
| `npm run typecheck`（最终） | exit 0。新测试首次有两处测试侧 wire 类型访问报错，修正类型标注后通过，无生产改动。`HARNESS-002-typecheck.log` |
| `npm test`（完整 suite，仅一次，沙箱外） | 114 tests：112 passed、1 failed、1 skipped；exit 1，约 66 秒。`HARNESS-002-bridge-final.log` |
| 失败用例定向复核 | `node --test --test-name-pattern 'catalog refresh and successive session launches' test/codex-executable.test.js`：1/1 pass，exit 0。`HARNESS-002-discovery-recheck.log` |

完整 suite 唯一失败为既有 Codex executable 发现夹具 `CODEX_EXECUTABLE_UNAVAILABLE / discovery_status=ETIMEDOUT`；单独复核通过，未改无关代码，也未重跑全套。保留全套 exit 1 的原始事实，不能表述为全套全绿。唯一 skip 为原有显式 opt-in 本机 Skill 读取测试。完整 suite 中本票 6 条 harness-computer、2 条 shutdown 与既有 Harness 回归全部通过。

原 Codex 沙箱下真实进程关停返回 `STOP_FAILED`，terminal 如实保存 running/null exit 与失败信息并保留锁；Emilia 在同 worktree 的 YCA direct 2/2 验证通过，按环境限制记录，不为绕过沙箱改生产终止语义或系统配置。完整 suite 在获准沙箱外执行，本票关停测试也通过。

采集失败测试通过记录 adapter 的公开 Interface 注入不可序列化快照（无法经 JSON MCP 构造），仍从产品 HTTP/持久历史核对缺口、健康和重启；正常路径使用真实 MCP、Filesystem/Git/PowerShell，输出截断用既有子进程 seam。没有新增压力/恢复矩阵或模型调用。

## 交接状态与限制

- Review：**pending fresh primary review**，未运行专业 Review，不能声明零 finding；Acceptance 未执行。真实浏览器可视/交互、ChatGPT→resident YCA、本票正式验收及 V0 全链均未验证，未部署，不作 stable 声明。
- best-effort 脱敏不保证识别任意秘密；源未提供信息保持 unknown/source-not-provided。磁盘不可写时不能承诺完整历史；坏 journal 不自动修复。正常结果中的 process_state 是历史快照，不是实时进程事实。
- 受测源码/测试 SHA-256 清单：本机 `.local/workflow-state/HARNESS-002-tested-content.json`；精确提交 SHA 由提交后 `.local/workflow-state/HARNESS-002.md` 记录，避免本文自引用。
- 提交主题：`feat: 保存同步电脑调用的持久历史与完整性事实`。无 push、PR、部署、resident 操作或 Review。
- 下一步：Emilia 核验 checkpoint 中 commit 与写集后启动一次 fresh primary Review，输入 fixed point→提交 diff、#42 Notes/Spec、规范、本 handoff 和必要测试证据；不传 implementation 聊天。#43 等共享底座交接后串行推进。

## SPEC-1 修复 Handoff（2026-09-19）

- 原 fresh primary full Review：`.local/workflow-state/HARNESS-002-review.md`；原 target `cf2361c3eaea30a4e20002471182313ef20ae4e8`。Standards passed / 0 findings；Spec 唯一 SPEC-1 / P2 / open。原未受影响结论与测试异常证据继续沿用。
- **SPEC-1：fixed / pending focused verification**。电脑来源 STOP_FAILED 不再跳过 Codex 停止：manager 新增 `stopRuns()`，仅尝试停止/等待自身 runs，不释放 writer；既有 `close()` 仍先停止再做 Harness 最后采集及 Store 关闭。main 的多来源协调收集电脑、Codex、同步记录收尾的全部结果，任一失败就保留分来源错误、只读观察与锁；全部成功后才调用最终 close。
- 正常 shutdown 与 startup error cleanup 复用同一协调；startup 清理失败也不提前关闭已建立的只读观察 listener。此处新增 `manager.js` 写集是 SPEC-1 所需，已先记录 checkpoint，不扩 #43/#44 或其他关闭/恢复策略。
- 首个最小受控双来源测试经生产 main、真实 MCP stop、manager 与只读 HTTP 观察，电脑关闭源返回 STOP_FAILED，Codex executor 使用无模型 fixture；修前 active.codex 仍为 1，明确红测 exit 1。修后 active.codex=0、run.stopped 可读，原失败事实存在、bridge.lock 保留，服务未伪装正常退出。只增加这一条回归，不新增恢复矩阵。
- 验证：新增用例定向 1/1 pass，exit 0；`node --test test/shutdown.test.js` **3/3 pass，exit 0**（获准沙箱外隔离执行）；`npm run typecheck` **exit 0**；`git diff --check` exit 0。日志：`.local/workflow-state/HARNESS-002-SPEC-1-red.log`、`HARNESS-002-SPEC-1-targeted.log`、`HARNESS-002-SPEC-1-shutdown.log`、`HARNESS-002-SPEC-1-typecheck.log`。
- 实际写集仅 4 文件：`tools/codex-session-bridge/src/main.js`、`src/manager.js`、`test/shutdown.test.js`（后两者同 bridge 根）和本 handoff。受测修复字节清单：`.local/workflow-state/HARNESS-002-SPEC-1-tested-content.json`。未重跑完整 suite，未处理 discovery ETIMEDOUT，未改系统环境。
- 提交主题：`fix: 独立尝试各执行来源关停并保留失败时的写锁`；精确 fix SHA 记入提交后 checkpoint。review_policy 仍 delegated，接收方 Emilia / engineering-workflow；下一步仅 fresh focused re-review，围绕 SPEC-1、原受审 target 到 fix commit 的 diff 与上述证据。未自行 Review、Acceptance、push、PR 或部署。
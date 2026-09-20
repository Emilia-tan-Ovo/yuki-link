# HARNESS-010 Implementation Notes

Ticket: `.local/HARNESS-010-ticket.md` / GitHub #50
Spec: `docs/specs/yuki-harness-v0.md`（Windows 登录后台启动、恢复观察、recording gate、禁止第二套 Supervisor）
Fixed point: `49fb936451d681449f6d00a70ff048ba393021d6`

## Implementation Decisions

### 1. 复用唯一启动拓扑，不新增后台管理者

- 唯一拓扑保持为 `YukiLink-ControlCenter-V0` 登录任务 → `Run-Supervisor.ps1` → Control Center / `Supervisor` → YCA → 进程内唯一 `Harness`。`createHarnessRuntime(...).start()` 仍是 collector 的唯一创建点；Harness HTTP listener 只是同一 Runtime 的可选只读投影，不能创建、启动或停止 collector。
- Control Center 冷启动时增加一次性 desired-state reconciliation：仅当持久化的 `units.yca.desired === "running"` 且 YCA 被可靠观察为未运行时，沿用 `YcaUnit.start({ recovery: true, commit: persistedCommit })` 启动 YCA。`desired === "stopped"`、观察未知、unowned、端口/锁冲突时均不启动、不接管。
- 这次 reconciliation 不读取或修改 `autoRecovery`，不改变 desired state，不触碰 tunnel；进程启动后的故障重试继续完全服从既有 `autoRecovery`、有限预算和 ownership 规则。由此，登录启动实现 Owner 已保存的 YCA 运行意图，而不是静默开启新的恢复策略。
- `Startup.ps1` / `Run-Supervisor.ps1` 的 Scheduled Task、`IgnoreNew`、有限重试和重复 manager 识别已满足唯一管理者要求；本票不改其行为。实际任务安装/启用和生产配置变更仍须 Owner gate。
- Control Center 的 YCA 配置增加可选、经端口冲突校验的 `harnessPort`，`YcaUnit` 只负责把它传为 `--harness-port`；未配置时仍后台采集但不开放 UI。现有配置保持可加载，真实登录验收前再经 Owner 授权配置生产端口。

### 2. 恢复的是观察身份与高水位，不是执行

- `harness/history.jsonl` 是 Harness 历史、`source_id` 和全局 cursor 的事实来源。重建时继续恢复 Project / Ticket / Conversation、Codex binding、已导入的 `(run_id, source_seq)`、thread、workflow、受管任务 binding 及其输出/lifecycle 高水位；后续 append 必须延续同一 `source_id` 和单调 cursor。
- 当前 YCA `RuntimeStore` 是 Codex session/run 状态与逐 run 事件的事实来源；`SessionManager.recover()` 只把遗留 active run 标成 `interrupted` 并记录 `BRIDGE_RESTARTED`，不得调用 `start` / `send` / executor。当前 task source 以 `service_epoch` 为身份；进程重启后的旧 task 只能标记 `source-epoch-expired`，不得恢复或重放。当前 Git、worktree 和 workflow checkpoint 每次从本地事实重新核对，不能用旧快照覆盖。
- Harness 初次 `start()` 在周期扫描前执行一次只读 recovery reconciliation。对每个已持久化 Codex binding，使用现有 Event interface 追加一条 `recovery.observed` 记录：包含 journal 启动高水位、持久化 binding 身份、当前 session/run 可用性和状态、Git/worktree/checkpoint attribution 结果，以及固定、脱敏的 gap code。不得自动 register/attach Ticket，不得创建 session/run/task，不得调用模型 catalog、Codex executor 或控制动作。
- 能补齐的 source events 仍按 source sequence 去重导入；session/run 不存在、事件尾不完整、Git/checkpoint 不可核对或 attribution 冲突时，写 `recovery.observed` 的明确 gap，并保持 Ticket 归属不变。若 journal 本身不可写，则不伪造该记录，以 `recording-failed` 和可读的既有前缀作为证据；历史 gap 不因后续 source 恢复而消失。
- 受管任务沿用 `TaskCollector` 已有的 `source-epoch-expired` / `source-unavailable` / lifecycle gap 记录，不另造第二套 cursor 或恢复协议。

### 3. UI 生命周期与 collector 生命周期解耦

- YCA 启动时先取得唯一 `RuntimeStore` writer lock、构造并启动一个 Harness，再建立 MCP/control/UI listeners。任何 listener 打开、请求、断开或重建都不能调用 `Harness.start()`，UI 端点只读取同一实例或其 durable journal。
- 关闭浏览器不关闭 Runtime；关闭/重开 Harness listener 也不改变 collector、source subscription 或执行 gate。重复打开页面只读取历史，不追加恢复记录或 source event；只有真实 source 变化或一次新的 Runtime 冷启动可以推进 cursor。
- Scheduled Task 的 `IgnoreNew`、Control Center config identity、YCA ownership/port/runtime lock 与 `Harness.start()` 的 timer 幂等共同构成 single-collector 证明；不增加独立 mutex、后台进程或第二个 Event Store writer。

### 4. 启动未就绪与记录失败继续 fail closed

- YCA 的公共 MCP listener 只能在 `RuntimeStore`、`SessionManager`、`ComputerTools` 和 Harness 已构造后开放。Harness journal 无效/不可写时保留 Harness 实例并报告 `recording-failed`；UI listener 绑定失败只报告 `HARNESS_UI_UNAVAILABLE`，不得影响后台 collector 和 gate。
- 所有外部 `new-side-effect` 入口继续统一经过 `gateHarnessExecution`：Harness unavailable、`collection-failed` 或 `recording-failed` 时，在 action / executor / process / filesystem mutation 之前拒绝。恢复健康不会重放先前拒绝的请求。
- `observe` 与 `manage-existing` 保持可用并返回 evidence gap；`record-only` 仅在 durable journal 可写的 `recording` / `collection-failed` 状态可用。不得用 UI disabled 状态作为门禁证据。

## Implementation Sequence

1. 在 Control Center 配置与 `YcaUnit` 启动参数中接通可选 `harnessPort`，保持旧配置兼容并校验所有本地端口互异。
2. 在 `Supervisor` 提供一次性 YCA startup reconciliation，并由 `src/main.js` 在 manager identity / unit 构造完成后调用；复用既有 ownership、release pinning 和错误码，不进入 tunnel 或周期恢复策略。
3. 在 Harness 私有启动流程中加入一次 recovery reconciliation，复用现有 Event interface 持久化 `recovery.observed`；不扩展公开执行 interface，不新增 writer。
4. 补齐定向自动化测试，再执行两个 package 的 typecheck/相关测试；真实 Windows 登录只在 Owner 授权生产 startup/config 变更后验收。

## Deterministic Test Seam

- `tools/control-center/test/supervisor.test.js`：重建带 `desired.yca=running` 的 state 后只启动缺失且可确认停止的 YCA；传递 pinned recovery release；不改 `autoRecovery` / desired；不调用 tunnel；stopped、unknown、unowned/conflict 均不启动。
- `tools/control-center/test/yca-integration.test.js`（Windows）：隔离端口启动真实 YCA，证明 `harnessPort` listener 可读、重复 `YcaUnit.start()` 不产生第二进程，manager adapter 重建仍采用同一 YCA；不调用模型或生产 tunnel。
- `tools/codex-session-bridge/test/harness.test.ts`：无 UI 时后台采集；反复创建/关闭只读 server 不增加 collector 或 cursor；Runtime 重建保持 source/Ticket/Conversation 身份和高水位，追加一次 recovery observation，补齐事件不重复；缺失 source/Git/checkpoint 形成持久 gap，executor/start/send 调用数保持 0。
- `tools/codex-session-bridge/test/harness-tasks.test.ts`：沿用并定向断言跨 Runtime 的旧 task epoch 只成为 `source-epoch-expired`，不会生成 child/process 或重放 task。
- `tools/codex-session-bridge/test/harness-execution-gate.test.ts`：保留 unavailable / collection-failed / recording-failed 的公共 MCP 门禁矩阵及“恢复不重放”；若生产 composition 改动影响构造顺序，再加一个最小 child-process 用例，断言只读成功而受控写目标未出现，不扩展压力矩阵。
- 实现后的定向命令：在 `tools/codex-session-bridge` 运行 `npm run typecheck` 及上述 Harness tests；在 `tools/control-center` 运行上述 Supervisor/YCA tests。完整 package suites 留给外层确定性验收。

## Real Windows Login Acceptance Plan

1. Owner gate 后，核对真实 Scheduled Task 的 marker/action/user、Enabled、`IgnoreNew`、有限 restart，核对生产配置含独立 loopback `harnessPort`；记录登录前 Control Center/YCA/tunnel 身份、desired、`autoRecovery`、running release、Harness `source_id` / cursor、Ticket/Conversation IDs 及 YCA session/run/request 计数。
2. 准备一个已有终态 run 的已绑定测试 Ticket，关闭全部 Harness 页面；执行真实 Windows 注销再登录（不是手工运行脚本）。期间不发任何 MCP/模型/任务请求。
3. UI 仍未打开时，等待 Scheduled Task 的有界启动窗口；用进程、Task Scheduler、Control Center status 和 loopback Harness endpoint 证明唯一 Control Center、唯一 YCA、唯一可读 Harness。确认 YCA 仅因预先保存的 `desired=running` 启动，`autoRecovery`、tunnel desired/running 和 startup task 定义未被本票静默改变。
4. 打开 Harness，确认原 Ticket/Conversation/history 仍可读，`source_id` 不变、cursor 单调增加且只出现一次本次 `recovery.observed`；其 session/run、Git/worktree/checkpoint 当前事实或明确 gap 与外部事实一致。确认 YCA store 没有新增 model session/run/request，Git/文件无自动执行副作用。
5. 关闭、重开并并行刷新 UI，确认进程/collector 数不变；无 source 变化时 cursor 不前进，历史一致。
6. 在隔离 runtime 做 recording-failure 公共入口验证：受控 `filesystem_write` / `powershell_execute` / session start 均在 action 前拒绝且目标效果不存在；只读 status/output/filesystem/Git 仍返回 evidence gap。恢复 storage 后不自动重放。生产历史不做破坏性故障注入。

HARNESS-010 到此只验收登录启动、单 collector、恢复观察与门禁；跨全部来源的最终收敛链和更广 recovery/drift 矩阵留给 #51。

## Deferred Details

- `recovery.observed` payload 的低风险字段命名、UI 中文标签和固定 gap code 名称由实现按现有 schema/style 决定；不得携带原始异常、凭据或未脱敏路径内容。
- 真实 production `harnessPort` 数值、Scheduled Task 安装/启用及 desired state 准备属于动态环境配置，实施代码不硬编码；Acceptance 时重新探测并经 Owner 授权。
- 不在本票增加任务输出跨进程持久化、自动 task 恢复、模型 session resume、Ticket 自动登记、第二套 Supervisor、额外 retry/stress 矩阵。

## Expected Direct Write Set

- Control Center：`tools/control-center/src/config.js`、`src/units.js`、`src/supervisor.js`、`src/main.js`、`config.example.json`，以及对应 `test/supervisor.test.js` / `test/yca-integration.test.js`（必要时最小触及 `test/manager-process.test.js`）。
- Harness：`tools/codex-session-bridge/src/harness/harness.ts`，以及 `test/harness.test.ts` / `test/harness-tasks.test.ts`；只有现有 Event schema 无法表达固定 recovery payload 时才最小触及 `src/harness/model.ts`。
- 不预期修改 `Startup.ps1`、`Run-Supervisor.ps1`、执行器、Codex request/session interface、tunnel 管理或 GitHub/workflow history。

## Context Plan

- **Core**：`.local/HARNESS-010-ticket.md`、本文件、根 `AGENTS.md`、`docs/specs/yuki-harness-v0.md` 第 19–25、80–84、94–113 行；`tools/control-center/src/{config,units,supervisor,main,startup}.js`、`scripts/{Startup,Run-Supervisor}.ps1`；`tools/codex-session-bridge/src/main.js`、`src/harness/{runtime,harness,journal,codex-source,task-collector,task-source}.ts` 及上列定向 tests。
- **Related**：`tools/codex-session-bridge/src/{store,manager,mcp}.js`，用于确认 RuntimeStore ownership、无重放 recovery 和公共 execution gate；HARNESS-004 只使用现有 `gateHarnessExecution` 公开契约与 `harness-execution-gate.test.ts`，不读取旧票完整记录。
- **Retrieval**：需要定位时检索 `desired`、`autoRecovery`、`YcaUnit.start`、`createHarnessRuntime`、`Harness.start`、`source_id`、`cursor`、`service_epoch`、`gateHarnessExecution`、`recovery.observed`。
- **Expansion triggers**：只有在现有 `YcaUnit` 无法按 persisted desired 安全启动、Event interface 无法留下恢复 gap、或公共 MCP 可在 Harness 构造前开放时，才扩读相邻实现；不得读取 `.workflow/history/**`、完整旧 Review/Acceptance/closeout 或完整 Git history。

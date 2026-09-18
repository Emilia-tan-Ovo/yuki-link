# 001 — 解耦 Codex run 等待与执行超时

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 让 Emilia 可以高效等待 Sylvia 的 Codex run，而不会因为观察端等待窗口结束或统一的短 wall-clock timeout 把仍在正常推进的 Agent run 杀掉。

**Blocked by:** None — can start immediately.

**Risk hint:** high

**Status:** ready-for-agent

## Acceptance criteria

- [ ] YCA 对 observation wait 与 run execution deadline 使用明确、独立的语义。
- [ ] 等待“新事件 / run terminal / observation window elapsed”任一条件满足时可以返回，不要求调用方高频 `get_status → sleep → get_output`。
- [ ] observation window elapsed 不会停止仍在运行的 Codex run。
- [ ] Workflow 不再为了轮询方便给正常 Agent 工作统一附加短 execution timeout。
- [ ] 对持续产生有效进展的长 run，可在超过旧 180s/默认短墙钟阈值后继续运行；测试可以使用可控时钟/fixture，不要求真实等待数分钟。
- [ ] 如果调用方明确配置 hard execution deadline，超时仍产生清晰、可追溯的 terminal 状态与 `RUN_TIMEOUT` 语义。
- [ ] 主动 stop、客户端断开、observation wait elapsed、hard execution timeout 四者不会被混为同一状态。
- [ ] 保持现有 session/run 历史、cursor output、idempotency 与 terminal-state 兼容性。
- [ ] 通过 YCA MCP 公共边界完成真实验收。

## Implementation-design boundary

具体采用扩展现有 output/status、增加 wait 工具、可续期 deadline、无默认 hard deadline 或其他内部设计，由 ticket-design 根据现有 manager/store/MCP seam 决定；本票不提前固定 API。

## Implementation Notes

- 保留 `timeout_ms` 作为显式 hard execution deadline：省略时持久化为 `null` 且不创建终止计时器，显式传入时继续使用现有范围并保留 `timed_out` / `RUN_TIMEOUT`；start/send 受理结果与 status 均暴露实际的 `null` 或数值。旧 run 的数值原样保留；state version 与 request fingerprint 不变，旧 request replay 仍返回原 run。
- 扩展现有 `codex_get_output`，增加可选 `wait_ms`（省略或 `0` 仍为即时读取，正值最长 60 秒），不新增工具。cursor、limit、事件分页和 final response 保持兼容；响应增加 `return_reason: events | terminal | wait_elapsed`。
- long-poll 先返回已有 cursor backlog；否则等待该 run 的新 durable event、terminal 状态或观察窗口结束。terminal 且没有未读事件时返回空事件页与 `terminal`；`wait_elapsed` 只结束本次读取，不改变 run。
- `RuntimeStore` 在 JSONL append flush 完成并推进 `event_count` 后通知按 run 订阅的 waiter；`SessionManager` 使用“检查 → 注册 → 再检查”与统一清理避免 lost wakeup，并用可注入 timer seam 分别驱动 observation wait 与显式 hard deadline。
- MCP handler 把 SDK 的 request `AbortSignal` 传给等待逻辑。取消或客户端断连只清理 waiter，并以 `OBSERVATION_CANCELLED` 处理；不 stop run。主动 stop、hard timeout、finish 与 restart recovery 继续通过 durable lifecycle event 唤醒观察者；manager close 在关闭 store 前清理残余 waiter。
- 回归测试覆盖：省略/显式 deadline、旧 runtime 与幂等 replay、超过旧阈值仍运行、三种 long-poll 返回、分页 backlog、check/register race、多 waiter、断连重连、stop/close/recover，以及 MCP HTTP 公共边界。测试用 fake timer/executor，不真实等待分钟级时长。


## 实现、Review 与候选验收状态

### 实现

- 实现提交：`0c688d9 feat: 解耦 Codex run 等待与执行超时`。
- 修改前有效 baseline：`95 passed / 0 failed / 1 skipped`。
- 实现后 targeted `bridge.test.js`：`20 passed / 0 failed`。
- 实现后完整 `npm test`：`101 passed / 0 failed / 1 skipped`。
- `node --check` 与 `git diff --check` 通过。

### Fresh full review

Fixed point 为 `92bc97e`，HEAD 为 `0c688d9`，使用独立 fresh reviewer session：

- Standards：**CLOSED**，0 finding。
- Spec：1 个中等 finding——尚缺 **resident YCA 的真实 MCP 公共边界验收**。该项属于 acceptance 阶段，不是已确认代码缺陷。

### 隔离候选真实 MCP / Codex 验收

2026-09-18 使用候选提交启动隔离 HTTP/MCP，并运行显式联网 `npm run test:live`：

- 工具发现：18 个；
- PowerShell：7.6.5 / Core；
- Astra high 首轮真实 run：completed；
- 同一 Codex thread 续聊：completed；
- 同 thread 切换至 Sol low：completed；
- 三个真实 run 的 `timeout_ms` 均为 `null`；
- live harness 使用 `codex_get_output(wait_ms)` 等待，不再使用固定 sleep + status/output 高频轮询；
- acceptance report：`passed: true`。

原始本机报告保存在候选 runtime 的 `live-1789715698419/acceptance.json`，runtime 不提交 Git。

这证明候选版本的真实隔离 MCP + Codex 链路通过；**不等于 resident YCA 已加载新实现**。

### 尚未完成

- [ ] 将候选代码合入正式分支并更新 resident YCA。
- [ ] 刷新 ChatGPT 端插件 schema，使现有 `codex_get_output` 暴露新增 `wait_ms`。
- [ ] 通过 ChatGPT → resident YCA 公共工具真实验证：
  - 省略 `timeout_ms` 后 run 为无 hard deadline；
  - `events / terminal / wait_elapsed` 三种 observation 结果；
  - 客户端 observation 结束/断连不停止 run；
  - 显式 hard timeout 仍保留 `RUN_TIMEOUT`。
- [ ] 完成上述证据后关闭 fresh review 的 Spec finding，并更新 Issue #23。

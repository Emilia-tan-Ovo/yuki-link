# HARNESS-004 实现说明

## 修改

- `Harness.executionGate` 成为公开 MCP 执行门禁的唯一策略 owner，并统一返回 recording 快照、`evidence_gap`，或抛出稳定的 `RECORDING_FAILED` / `COLLECTION_FAILED` / `HARNESS_UNAVAILABLE`。
- `src/mcp.js` 的统一注册 wrapper 为 21 个工具显式声明 `record-only`、`observe`、`new-side-effect`、`manage-existing` 四类；gate 位于 schema 校验之后、action 与同步调用记录之前。
- 6 个 `new-side-effect` 在 recording 降级或 Harness unavailable 时 fail-closed；10 个 `observe` 与 2 个 `manage-existing` 继续执行并报告证据缺口；3 个 `record-only` 仅在 Journal 仍可靠的 `collection-failed` 状态继续。
- 降级不会自动停止既有 run/task，也不会排队或在恢复后重放被拒动作；恢复后必须重新发起显式调用。

## 验证范围

- 新增公开 MCP 参数化矩阵，覆盖 21 个工具在 `recording-failed`、`collection-failed`、unavailable 下的分类行为。
- 使用真实 ComputerTools/OwnedTasks seam 验证文件写入、文件移动、PowerShell sentinel、task spawn 在 gate 拒绝后没有发生；既有 task 的 status/output/stop 在降级时仍可用并携带 `evidence_gap`。
- 验证 health 恢复本身不重放动作，只有新的显式调用可执行。
- 运行受影响的 Harness、computer、bridge 回归与 TypeScript typecheck；未运行 full suite。
- 补充运行 `test/tasks.test.js` 时 25 项中 24 项通过；`root exit with open pipes remains owned and never kills a stale root PID` 的 `completion_reason` 断言单独复跑仍为 `null`（期望 `stream_error`）。当前差异未修改该 task 状态机，本票不扩展修复。

## Review 状态

实现已提交，等待 delegated fresh Review；本文件不声明 Review 或 Acceptance 已通过。

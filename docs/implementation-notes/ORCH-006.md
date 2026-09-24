# ORCH-006 — 日常 Orchestrator 能力收口与代表性真实协作链验收

状态：ticket-design 完成；等待 fresh implementation。

Ticket：[GitHub #95](https://github.com/Emilia-tan-Ovo/yuki-link/issues/95)；Source Spec：[GitHub #89](https://github.com/Emilia-tan-Ovo/yuki-link/issues/89)。#95 所列仓库 Spec 路径 `docs/specs/emilia-orchestration-consistency-v0.md` 在当前 fixed point 不存在；以 GitHub #89 为正式 Spec 来源，不为本票新建镜像。

Fixed point：`8ec4966b7c779745855e8e39c665a4402dbd2f7f`；worktree：`.local/worktrees/orch-006`。

## Implementation Notes

- **能力边界：**当前 `tools/codex-session-bridge/src/mcp.js` 在同一 MCP tool list 中注册高层 launcher 与低层 primitives，平台侧没有已验证的按 Orchestrator 身份隐藏能力。因此本票公开状态明确为 **safe recommended path**，不能声称低层绕过已被结构性禁止。正常 Workflow 的启动与 Conversation 归属只推荐 `start_workflow_agent` 及 `start_ticket_implementation` / `start_ticket_review` 兼容高层入口；`codex_start_session`、`harness_attach`、`harness_associate_child_conversation` 明确限于兼容、诊断或管理员显式操作。保留既有工具功能与历史兼容。Owner 本轮观察为 production MCP 已暴露 `start_workflow_agent`，但当前 ChatGPT 插件 schema 尚未刷新；两者分别记录，不把 production tool list 等同于本轮插件可调用能力。
- **代表性 implementation：**先对照 `tools/codex-session-bridge/README.md`、公开 MCP tool description 与生产实际 tool list，做最小的能力说明/分类收口。现有 MCP list 测试仅断言 `start_ticket_review` 等旧入口，implementation 可在该入口增加高层入口及低层边界的定向断言；若现状已满足，记录实际核对证据，只修正具体缺口，不为制造 diff 添加新 launcher、权限系统或隐藏机制。此变更由 `start_ticket_implementation` 启动的 fresh implementation session 完成，固定 delegated Review、Main destination、Owner native permissions；若当前插件尚不可调用该入口，由已验证的外层生产 MCP 客户端执行，不能改用低层 `codex_start_session` 冒充本 AC。
- **真实链路：**由外层确定性地准备 Ticket 登记、可信 authority、Workflow revision/subject/content identity、fixed point、依赖与服务版本；确保单模型线空闲后，以唯一 `request_id` 启动一次 implementation。保存 durable operation、session/run、Main binding、冻结权限、Context Packet 来源和 Engineering Memory 过滤结果。implementation handoff 后由外层记录 Review intent，再用 `start_ticket_review` 启动 fresh reviewer；用 Harness 与 runtime 核对 Review child 与 Main 分离、实际 session/run、revision、subject identity 和 review isolation。不要用模型自述替代这些事实。
- **重启与恢复：**在 operation/Review/finding/next-action 的可观察状态已持久化后，由现有服务 owner 按正常流程重启相关服务；重启前后保存服务版本、operation ID、session/run ID、Workflow revision 与观察时间。重启后只调用只读 `prepare_ticket_resume` 并与 durable journal、Git/checkpoint、Harness/runtime 当前事实交叉核对；不重发原 launch、不自动续跑、不以重新启动 reviewer 证明恢复。
- **Context 与 Memory：**核对 Packet 只投影 active + applicable 的短 Engineering Memory 摘要及 authority/source reference，并保留 stale/conflict/unknown；Git、checkpoint、Harness、runtime 的当前事实仍按各自 source of truth 核验。若 Memory 为空，记录空集与查询条件，不制造记录。
- **验收边界：**一条代表性链路证明 V0 implemented + representative accepted；Review finding 依既有 fresh fix / focused re-review 流程处理，但不额外构造故障矩阵。#95 排除项保持排除，长期 stable 不在本票宣称。

## Implementation Sequence

1. 由外层完成 0-token preflight 与可信 authority/Workflow 准备；implementation session 只处理能力说明/分类的最小缺口和定向验证。
2. 从同一 fixed point 核对实现 diff 与定向测试，完成 delegated handoff；外层记录实际 receipt、run、binding、Packet 与 usage。
3. 启动 fresh primary Review，核对 child isolation 与 Review 证据；按既有 finding gate 处理实际 finding。
4. 按现有服务 owner 流程重启，调用 `prepare_ticket_resume`，交叉核对恢复现场并逐项记录 #95 AC 的外部证据。

## Deferred Details

- 具体断言名称、README 小节位置与证据文件名按现有约定在 implementation 中确定。
- 平台日后若提供真正的按身份 capability filtering，另行验证并跟进；本票不引入新的 capability 服务或权限模型。

### Context Plan

- **Core:** GitHub #95 全部 AC；本 Notes；`AGENTS.md`；`tools/codex-session-bridge/README.md` 工具与权限边界；`tools/codex-session-bridge/src/mcp.js` 的 `createMcpServer` 工具注册；`tools/codex-session-bridge/test/bridge.test.js` 与 `tools/codex-session-bridge/test/computer.test.js` 的公开 tool list 断言。
- **Related:** GitHub #89 的 capability exposure、Context Packet/Memory 与代表性验收决定；`docs/implementation-notes/ORCH-007.md` 的已交付统一 launcher/兼容边界；真实链路按需读取 `tools/codex-session-bridge/src/orchestration/workflow-agent-launcher.ts`、`tools/codex-session-bridge/src/orchestration/execution-operations.ts`、`tools/codex-session-bridge/src/orchestration/context-assembler.ts`、`tools/codex-session-bridge/src/orchestration/harness-context-source.ts` 与对应定向测试。
- **Retrieval:** 搜索 `start_ticket_implementation`、`start_ticket_review`、`prepare_ticket_resume`、`start_workflow_agent`、`codex_start_session`、`harness_attach`、`harness_associate_child_conversation`、`tools/list`；实际运行状态以当次 operation/session/run、Harness journal、Workflow snapshot、Git/checkpoint 和服务 owner 记录为准。
- **Expansion triggers:** 若真实 tool list 已能按 Orchestrator 身份可靠过滤，先核实平台边界再决定是否能宣称结构性限制；若可信 authority、recording、subject identity、服务 ownership 或已有 active run 不满足 launch gate，停止新副作用并按现有恢复流程处理，不扩充本票功能；若真实链路暴露 #95 排除项，仅记录 follow-up。

## Implementation Handoff

- **来源与身份：**GitHub #95、Source Spec #89、本 Notes；worktree `.local/worktrees/orch-006`，branch `codex/orch-006-convergence`，fixed point 与实现前 HEAD 均为 `8ec4966b7c779745855e8e39c665a4402dbd2f7f`。提交 SHA 以同 worktree 的 `.local/workflow-state/ORCH-006.md` 为准。
- **范围：**现有 `tools/codex-session-bridge/README.md` 与 `src/mcp.js` 已将 `start_workflow_agent` 作为正常 Workflow 推荐入口，并明确低层工具的兼容、诊断、管理员边界。没有改动运行逻辑。`tools/codex-session-bridge/test/bridge.test.js` 改为核对公开 tool list 的高层入口和低层描述；移除已过期的 14 工具总数断言。
- **测试：**`node --test --test-name-pattern='real MCP HTTP clients reconnect' test/bridge.test.js`（在 `tools/codex-session-bridge`，Node v24.18.1）最终 exit 0，1/1 通过。初次运行因旧断言 `19 !== 14` 失败，修正断言后通过。`git diff --check` exit 0。受测源码 `bridge.test.js` SHA-256 为 `ca2b09ef164c2ec04b71bcec1543db48350f6be9863339c9dec8b3ed0cfec8a4`。未运行 full suite 或 typecheck；本次无生产源码变更。
- **Review：**`review_policy=delegated`，接收方 Ticket Main；fresh primary Review 尚未执行，finding 状态未知。本 handoff 不代表真实链路验收或长期稳定使用。
- **限制与下一步：**平台仍公开低层 primitives，状态仅为 safe recommended path。上层先以 durable state 对齐 Workflow revision 4 与 `prepare_ticket_resume`，核对本次真实 implementation operation/session/run/Main receipt 和 Context Packet；随后按 #95 使用 `start_ticket_review` 启动 fresh Review，并在后续验收阶段完成服务重启后的只读恢复核验。客户端 stop/timeout 后先 reconcile，不能盲重放。

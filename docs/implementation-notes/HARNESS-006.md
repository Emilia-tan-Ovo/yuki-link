# HARNESS-006 Implementation Handoff

## 来源

- Ticket：GitHub Issue #46 `HARNESS-006：Fresh Review 子 Conversation 与隔离关系`
- Parent Spec：GitHub #39 / `docs/specs/yuki-harness-v0.md`
- Implementation Notes：Issue #46 当前正文（Emilia/YCA 于 `2026-09-20T02:40:16Z` 回读确认）
- 本地 checkpoint：`.local/workflow-state/HARNESS-006.md`

## 身份

- worktree：`C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/harness-006`
- branch：`codex/yuki-harness-v0-006`
- fixed point / 开始时 HEAD：`8ebfc5f7234b43bb552633cb8b73a2adaf9fbd6b`
- 当前状态：未 commit；以下实现、测试与本文均为工作区字节，等待上层 Review。

## 范围与改动

- 新增 `conversation-model.ts` / `conversations.ts` 深模块，集中处理显式 child Conversation relation、Workflow execution ref 交叉验证、request 幂等、binding 归属冲突、单 Journal operation 持久化、重启重建、隔离 assessment 与导航投影。
- 新增 record-only MCP `harness_associate_child_conversation`。它只关联已存在的 Review / Acceptance Agent session+run，不调用 start/send/resume；既有 `harness_attach` 继续只绑定 Ticket 主 Conversation。
- Review schema 新增真正 optional 的 `execution_refs`；缺失保持旧快照与旧 request fingerprint 兼容，并使 child association 因来源不足而拒绝，不迁移历史。
- Full Review / focused re-review / 实际 Agent Acceptance 通过稳定 identity 与真实 Codex runtime ref 建立子 Conversation。Focused relation 投影原 Review/finding；deterministic Acceptance 不可建立；不存在的 Standards/Spec participant 不造占位。
- 子 relation 与 run binding 在一条 flush Journal operation 后发布；保存失败不发布内存关系、binding 或成功回执。相同 request_id/payload 返回原回执，不同 payload 返回 `REQUEST_CONFLICT`；主/子抢占返回 `ATTRIBUTION_CONFLICT`，跨 Ticket 旧主归属继续保持 `ATTRIBUTION_MISMATCH`。
- 隔离结论来自 Workflow ref、真实 session/run、首次 run 和 thread.started：证据完整为 `verified`，来源不足为 `unknown`，发现复用/冲突为 `mismatch`。Workflow 自报 `isolated` 与 Harness assessment 分开展示。
- Ticket JSON/HTML 继续展示主 Conversation，并只列实际子 Conversation；新增 GET-only `/api/conversations/:id` 与 `/conversations/:id`，沿用 Host/Origin、cookie、CSP、no-store、escaping 和 cursor 分页。子 execution 事件不混入主 Conversation records。
- README 已记录公开契约、边界和能力等级；未扩到 #47+、非 Codex Provider、自动 reviewer 编排、Changes、服务管理、自启/resident。

## 文件

- `tools/codex-session-bridge/src/harness/conversation-model.ts`（新增）
- `tools/codex-session-bridge/src/harness/conversations.ts`（新增）
- `tools/codex-session-bridge/src/harness/model.ts`
- `tools/codex-session-bridge/src/harness/harness.ts`
- `tools/codex-session-bridge/src/harness/workflow-model.ts`
- `tools/codex-session-bridge/src/harness/server.ts`
- `tools/codex-session-bridge/src/mcp.js`
- `tools/codex-session-bridge/test/harness-conversations.test.ts`（新增）
- `tools/codex-session-bridge/test/bridge.test.js`
- `tools/codex-session-bridge/test/computer.test.js`
- `tools/codex-session-bridge/test/harness-tasks.test.ts`
- `tools/codex-session-bridge/test/tasks.test.js`
- `tools/codex-session-bridge/README.md`
- `docs/implementation-notes/HARNESS-006.md`（本文）

## 测试

- TDD 红灯：`node --test test/harness-conversations.test.ts`，exit 1；旧 Workflow Review schema 拒绝 `execution_refs`，随后补最小纵切。
- 实现期 typecheck 红灯：`npm run typecheck`，exit 1；发现 union narrowing 两处，修复后转绿。
- 扩展 child Conversation 定向测试：`node --test test/harness-conversations.test.ts`，最终 exit 0（5/5），覆盖 Full/focused/Agent Acceptance、deterministic Acceptance 拒绝、无 participant 占位、主/子历史隔离、幂等/冲突、Journal 写失败、重启重建及 isolation verified/unknown/mismatch。
- 兼容定向测试首次：`node --test test/harness.test.ts test/harness-workflow.test.ts test/harness-conversations.test.ts`，exit 1（16/17）；仅因跨 Ticket 主归属错误码被误改为 `ATTRIBUTION_CONFLICT`，修正为旧 `ATTRIBUTION_MISMATCH`。
- 错误码回归：`node --test --test-name-pattern "restart and session switch|association 请求" test/harness.test.ts test/harness-conversations.test.ts`，exit 0（2/2）。
- 最终定向测试：`node --test test/harness.test.ts test/harness-workflow.test.ts test/harness-conversations.test.ts`，exit 0（17/17）。
- 最终 typecheck：`npm run typecheck`，exit 0。
- `git diff --check`：exit 0；仅显示仓库既有 Windows LF/CRLF 提示。
- Emilia + YCA 首次 full suite：145 tests / 136 pass / 8 fail / 1 skip。4 个失败是新增工具后遗留的旧工具数量断言；随后只把 9→10、21→22 四处机械同步，并定向复验 4/4 pass。
- 机械同步后再次 full suite：145 tests / 140 pass / 4 fail / 1 skip。#46 Conversation/Workflow/Harness 路径全部通过；剩余 3 条 `codex-executable.test.js` discovery 失败与 1 条 `tasks.test.js` open-pipes timing 失败。
- executable discovery 隔离复跑：`node --test test/codex-executable.test.js`，exit 0（4/4），证明 full-suite 里的 3 条 discovery 红项为整套运行时环境/时序脆弱性，不是 #46 功能回归。
- 已知 task timing 隔离复跑：`root exit with open pipes remains owned and never kills a stale root PID` 仍 fail；#45 handoff/history 已明确记录该问题为本票前既有测试脆弱项，本票不扩修。

## Review policy / Finding / 风险

- Review policy：`delegated`；接收方为 Emilia + YCA 上层，后续启动 fresh primary Review。
- Review：pending，implementation session 未启动 reviewer，也未给出 Review 通过结论。
- Finding：尚无 Review finding；不能解释为“零 finding 已通过”。
- Acceptance：未执行；未运行正式 Acceptance。
- full suite 的剩余 4 个红项均与 #46 直接实现无关：3 个 executable discovery 可隔离 4/4 通过，1 个 task timing 是 #45 前已记录的既有问题。

## Commit 与下一步

- Commit：本 handoff 写入后由 Emilia + YCA 机械提交；精确 commit SHA 记录在 post-commit checkpoint，避免文档自引用。
- 下一步：捕获最终 Review subject，并启动 fresh bounded primary Full Review。Reviewer 只接收 Issue #46/Notes、fixed point/commit/diff identity、本 handoff、规范引用与上述精简测试结果，不接收 implementation 聊天或 full-suite 长日志。

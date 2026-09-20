# HARNESS-006 Implementation Handoff

## 来源与身份

- Ticket：GitHub Issue #46 `HARNESS-006：Fresh Review 子 Conversation 与隔离关系`
- Parent Spec：GitHub #39 / `docs/specs/yuki-harness-v0.md`
- Implementation Notes：Issue #46 当前正文（Emilia/YCA 于 `2026-09-20T02:40:16Z` 回读确认）
- worktree：`C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/harness-006`
- branch：`codex/yuki-harness-v0-006`
- fixed point：`8ebfc5f7234b43bb552633cb8b73a2adaf9fbd6b`
- 行为实现 commit：`e63663cd05145fa5f9e6ce1a4533f88b0884a772`（`feat: 增加 Fresh Review 子 Conversation`）
- 最终待审 HEAD 以 post-commit checkpoint / review-subject 为准；本文的后续证据修订只记录测试事实，不改变生产行为。

## 范围与改动

- 新增 `conversation-model.ts` / `conversations.ts` 深模块，集中处理显式 child Conversation relation、Workflow execution ref 交叉验证、request 幂等、binding 归属冲突、单 Journal operation 持久化、重启重建、isolation assessment 与导航投影。
- 新增 record-only MCP `harness_associate_child_conversation`：只关联已真实启动的 Review / Acceptance Agent session+run，不调用 start/send/resume；既有 `harness_attach` 继续只绑定 Ticket 主 Conversation。
- Review schema 增加真正 optional 的 `execution_refs`，缺失时保持旧快照/request fingerprint 兼容；child association 只接受真实、匹配的 Codex runtime ref。
- Full Review / focused re-review / 真实 Agent Acceptance 使用独立子 Conversation；focused relation 关联原 Review/finding；deterministic Acceptance 不创建子 Conversation；不存在的 Standards/Spec participant 不造占位。
- 子 relation + run binding 只在 Journal flush 成功后发布。相同 request_id/payload 幂等；不同 payload 返回 `REQUEST_CONFLICT`；主/子抢占为 `ATTRIBUTION_CONFLICT`，跨 Ticket 旧主归属保持 `ATTRIBUTION_MISMATCH`。
- isolation 结论来自真实 Workflow ref、session/run、首次 run 与 thread.started；完整证据为 `verified`，来源不足为 `unknown`，复用/冲突为 `mismatch`。Workflow 自报 `isolated` 与 Harness assessment 分开显示。
- Ticket JSON/HTML 保留主 Conversation，并仅导航到真实存在的子 Conversation；新增 GET-only `/api/conversations/:id` / `/conversations/:id`，沿用 Host/Origin、cookie、CSP、no-store、escaping 与 cursor 分页。
- 新增第 22 个 YCA 工具后，Emilia + YCA 机械同步 4 处既有工具数量断言：bridge 9→10、完整 YCA 21→22；未改变这些测试的其他行为。
- Out of scope 保持不变：#47+、非 Codex Provider、自动 reviewer 编排、Changes、服务管理、自启/resident。

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

## 测试与外层证据

- child Conversation 定向：`node --test test/harness-conversations.test.ts` → 5/5 pass。
- 受影响 Harness/Workflow/Conversation：`node --test test/harness.test.ts test/harness-workflow.test.ts test/harness-conversations.test.ts` → 最终 17/17 pass。
- `npm run typecheck` → exit 0。
- `git diff --check` / staged diff check → exit 0；仅有 Windows LF/CRLF 提示。
- 外层 full suite 在审核中断/恢复期间有多次确定性观测：本轮 durable YCA task 明确记录一次 **145 / 136 pass / 8 fail / 1 skip**，另一条重复外层证据链曾记录 **145 / 137 pass / 7 fail / 1 skip**。两次都包含 4 个新增工具后的旧工具数量断言失败，其余集中在 executable-discovery / task-timing；不把这些波动结果冒充唯一稳定 baseline。
- 只机械同步 4 个工具数量断言后，相关定向复验 → **4/4 pass**。
- 第二次外层 full suite：145 tests / **140 pass / 4 fail / 1 skip**。#46 Conversation/Workflow/Harness 路径及工具数量回归全部通过。
- 第二次 full suite 剩余 4 个红项：3 个 `codex-executable.test.js` discovery/timeout + 1 个 `tasks.test.js` 的 `root exit with open pipes...`。
- executable discovery 隔离复跑也出现环境/时序波动：本轮 YCA direct 一次 `node --test test/codex-executable.test.js` 明确 **4/4 pass**；另一条重复外层证据链记录 **2/4 pass、2/4 fail**（`CODEX_EXECUTABLE_UNAVAILABLE` / `ETIMEDOUT`）。相关生产/测试文件不在 #46 写集；因此结论是这些测试在当前环境下不稳定，而不是宣称它们已稳定通过或由 #46 引入回归。
- task timing 隔离复跑：`root exit with open pipes remains owned and never kills a stale root PID` → **0/1 fail**（actual `null` / expected `stream_error`）。HARNESS-005 handoff/history 已记录该类 task timing 为本票前已知问题，本票不扩修。
- HARNESS-005 既有证据同时记录：其 full suite 曾存在 executable discovery / task timing 脆弱项，executable discovery 隔离 baseline 可通过。

## Review policy / 风险

- Review policy：`delegated`；由 Emilia + YCA 启动 fresh primary Full Review。
- Review：pending；implementation session 未自审。
- Finding：尚无 Review finding；不能解释为“零 finding 已通过”。
- Acceptance：未执行。
- 模型成本：ticket-design + implementation 累计 input 5,299,916；implementation 单 run 4,301,297 input 触发 cost anomaly。后续 Review 必须使用 bounded context，不传 implementation 聊天/full-suite 长日志，不做 broad history scan，raw input 目标 ≤600k。

## 下一步

- 以 post-commit checkpoint 中的最终 HEAD 与 `.local/workflow-state/HARNESS-006-review-subject.json` 为唯一 Review subject 身份。
- fresh reviewer 串行执行 Standards → Spec；只读取 Issue #46/Notes、相关 Spec/AGENTS/review rules、本文、精确 diff/必要代码切片与上述测试摘要。
- Review 完成后重新运行 review-subject helper 校验内容未漂移；有 finding 则 fresh fix session，全部适用通过后再进入 Acceptance。

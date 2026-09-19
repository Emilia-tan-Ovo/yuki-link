# HARNESS-005 · Implementation Handoff

- 来源：HARNESS-005 / GitHub #45、`docs/specs/yuki-harness-v0.md`、最终 Implementation Notes、`.local/workflow-state/HARNESS-005-review.md`，以及已合并的 #42/#43 接口与 handoff。
- 身份：worktree `.local/yuki-harness-v0-005`；分支 `codex/yuki-harness-v0-005`；fixed point / 实现前 HEAD `caca7902b9a4ddddbe1e7b35983346a6302f6c6e`。
- 授权：仅 #45 实现及 primary Review 的 STD-001、SPEC-001～004 finding 修复、必要定向测试/typecheck、本地 commit 与本 handoff。`review_policy: delegated`，接收方 Emilia / engineering-workflow；本 fix session 不启动 Review。

## 实际交付

新增公开 MCP 入口 `harness_record_workflow`。它只为已登记 Ticket 保存完整结构化 Workflow 快照，Project 与主 Conversation 从 `ticket_id` 推导；不执行下一阶段、不调用模型、不运行测试、不写 Git。快照覆盖 checkpoint、subject、artifact、Review 两轴、finding、Acceptance、closeout 与已声明 runtime 引用。

记录使用 Ticket 内单调 revision、`previous_revision` 与 request 幂等：相同 request/受保护 payload 返回原 event/cursor，不同 payload 返回 `REQUEST_CONFLICT`；新 request 的旧 `expected_revision` 返回 `WORKFLOW_REVISION_CONFLICT`。Journal append+flush 成功后才发布 revision；保存失败不更新当前投影。旧 v1 记录不迁移，重启从同一 Journal 重建 revision、幂等索引与当前 Workflow。

新增安全只读来源核对：文件只允许位于 Ticket 登记 worktree，拒绝受保护路径，不读取 URL 或其他 worktree；引用文件上限 64 KiB。checkpoint 字段、artifact SHA-256、Git HEAD/branch/status/相关文件身份及可取得的 Codex run 状态形成 `verified/stale/mismatch/unknown/not-applicable` assessment。后台刷新只在事实变化时追加 observation，不推进提交 revision；A→B→A 保留第三次观察。

首页与 Ticket JSON/HTML 投影 phase、Review/finding、Acceptance、closeout、applicability 和证据。只有明确 Acceptance passed、逐 AC 证据、适用 subject、full Review/focused verification 与 finding 门槛同时满足时才显示当前 accepted；run completed、文件存在或报告文字不会自动推出验收通过。页面仍保持 loopback/Host/Origin/cookie/CSP/no-store/GET-only 和 HTML 转义，没有新增浏览器写入口或控制按钮。

Workflow 记录加入 #42/#43 已有 journal union、cursor、单 writer 与分来源 recording health；未改同步电脑调用、OwnedTasks、执行器、manager/store、shutdown、Control Center/Supervisor 或 resident 配置。仓库 Workflow Skill/checkpoint 模板只增加“已登记且入口可用时保存成功回执”的可选约定；未启用 Harness 时保持原流程。

实际写集（除本文件外；实现提交后 Emilia 另补 1 个旧工具数量断言）：

- 新增 `tools/codex-session-bridge/src/harness/workflow-model.ts`、`workflow-source.ts`、`workflow.ts`、`test/harness-workflow.test.ts`。
- 修改 `src/harness/model.ts`、`harness.ts`、`server.ts`、`src/mcp.js`。
- 修改 `test/computer.test.js`、`test/tasks.test.js`、`test/harness-tasks.test.ts` 的 21 工具 schema 断言与名称；实现后 full suite 又发现 `test/bridge.test.js` 仍保留旧 8 工具断言，Emilia 机械改为 9 并定向复验通过。
- 修改 `tools/codex-session-bridge/README.md`、`.workflow/skills/engineering-workflow/SKILL.md`、`checkpoint-template.md`。

## Fresh finding fix

修复基线为 `ca3d01ecd4565e6f3ff2e957ab4e557408f209e6`，本次只处理 primary Review 的五项 finding：

- STD-001：按 porcelain v1 `-z` 协议消费 rename/copy 的第二个来源路径，subject 只比较当前目标路径；新增 staged rename 定向回归。
- SPEC-001：入口仅拒绝真正跨票的 `subject.ticket_ref`；当前 Ticket 的 checkpoint `ticket_key` 冲突进入 assessment、Journal 与 API 投影并保持 `mismatch`。
- SPEC-002：Acceptance 新增向后兼容的 `evidence_refs`，deterministic actor 可引用 `owned-task`、`sync-call` 等工程 runtime evidence；`execution_refs` 继续专用于 Agent，并要求指向带 session/run 身份的 `codex-run`。
- SPEC-003：`accepted` 要求当前 subject 具备 HEAD 与全部 dirty 文件哈希身份；无 finding 时 full Review 必须覆盖当前 subject，有 finding 时 origin full Review 与覆盖当前 subject 的 focused verification/finding 链必须完整且 verified。
- SPEC-004：首页集中标记 stale/mismatch、failed/incomplete 以及 open/fixed/fixed-unverified finding，异常行使用 warning 样式和“异常待处理”标签，正常行不添加 warning class。

本次修复写集仅为 `workflow-source.ts`、`workflow.ts`、`workflow-model.ts`、`server.ts`、`harness-workflow.test.ts` 与本 handoff；未修改 #44/#46+、未运行 full suite、未做 GitHub 写入。

## 测试与证据

环境：Node `v24.18.1`、npm `11.16.0`。本 worktree 初始没有 `node_modules`，首次 `npm run typecheck` 因 `tsc` 不存在 exit 1；随后按 lockfile 执行 `npm ci --offline --ignore-scripts`，exit 0，无依赖或 lockfile 变更。

| 验证 | 实际结果 |
| --- | --- |
| 初始 `node --test test/harness-workflow.test.ts` | 1 failed，exit 1；`harness_record_workflow` 尚不存在，公开调用返回 error，符合红灯预期。 |
| 最终 `node --test test/harness-workflow.test.ts test/harness.test.ts` | 7/7 passed，exit 0。覆盖公开 MCP→Journal→Project/Ticket API/HTML、request/revision/归属冲突、Review/finding/fix/focused/Acceptance 链、stale A→B→A、保护路径、脱敏、保存失败、重启重建及原 Harness 回归。 |
| `node --test --test-name-pattern 'real stdio service' test/computer.test.js` | 1/1 passed，exit 0；真实 stdio schema 为 21 工具，Codex 不可用不影响电脑入口。 |
| `node --test --test-name-pattern 'service epochs reject' test/tasks.test.js` | 1/1 passed，exit 0；Owned Task schema/旧行为保持。 |
| `node --test --test-name-pattern '同 request 的 Ticket' test/harness-tasks.test.ts` | 1/1 passed，exit 0；Ticket 归属兼容与 21 工具 schema 通过。 |
| 最终 `npm run typecheck` | exit 0。 |
| `git diff --check` | exit 0；仅有 Git 的 CRLF 提示，无 whitespace error。 |
| Emilia 外层 full suite | 125 tests / 120 pass / 4 fail / 1 skip。其中 1 个失败是 `bridge.test.js` 旧工具数断言（8→9），随后定向复验 1/1 pass；其余 3 个为既有 executable discovery（2）/ task timing（1）脆弱测试，未在本票扩修。 |
| finding fix 红灯 `node --test test/harness-workflow.test.ts` | exit 1；新增结构字段尚未实现，8/8 被 schema 拒绝；实现结构后剩余伪造 Agent 引用断言暴露 MCP schema 层拒绝形态，收紧为公开 API `isError` 断言。 |
| finding fix 定向 `node --test test/harness-workflow.test.ts` | 8/8 passed，exit 0；逐项覆盖 staged rename、checkpoint mismatch/跨票拒绝、deterministic evidence/Agent 身份、accepted 当前内容与 Review 链、首页异常/正常显示。 |
| finding fix 受影响回归 `node --test test/harness-workflow.test.ts test/harness.test.ts` | 12/12 passed，exit 0。 |
| finding fix `npm run typecheck` | exit 0。 |
| finding fix `git diff --check` | exit 0；仅有 Git 的 LF→CRLF 提示，无 whitespace error。 |

full suite 已由 Emilia 在实现提交后通过 YCA 外层执行一次，并如实保留上述 3 个既有非本票失败；未执行真实浏览器可视交互、ChatGPT→resident YCA、部署或 V0 全链验收。测试使用真实 MCP/HTTP/Journal/Git/文件系统及隔离仓库，只有 Codex source 使用无 session fixture；这些结果证明源码与定向 fixture 通过，不表示真实链路 accepted 或日常 stable。

## 交接状态

- Review：primary Review 的 5 项 finding 已实现修复并处于 **fixed-unverified**；**pending fresh focused re-review**。本 fix session 未自行 Review，不能声明 finding 已 verified 或两轴通过。
- Acceptance：未执行；测试中的结构化 Acceptance 只是产品行为 fixture，不是 #45 的正式验收。
- 已知边界：外部 reference 不自动抓取；不可取得或未声明依赖的来源保持 unknown/not-applicable。best-effort 脱敏不保证识别任意秘密。assessment 只核对可安全读取的明确来源，不替 Emilia 判断报告语义。
- 提交主题：`fix: 修复 Workflow Review findings`。精确 commit SHA 由提交后 `.local/workflow-state/HARNESS-005.md` 记录，避免本文件自引用。
- 下一步：Emilia 核对 `ca3d01ecd4565e6f3ff2e957ab4e557408f209e6`→finding-fix commit 的写集和本 handoff 后，使用 fresh context 启动一次 delegated focused re-review；只复核 STD-001、SPEC-001～004 及其回归，不携带 implementation/fix 聊天。无 push、PR、部署或 GitHub 写入。

## SPEC-003 fresh micro-fix

- 修复基线：`d5e907c478bd6908742500b1fea0ad0571279caf`；本轮只处理 focused re-review 遗留的 SPEC-003 P1。
- Review 与 finding 新增可选 `subject_identity`。它是规范化 `HEAD + staged/unstaged/untracked path/SHA-256` 的 SHA-256 digest；路径分组内稳定排序并统一使用 `/`。
- `accepted` 不再只依赖自由文本 `subject_id`：无 finding 时 full Review 的身份必须等于当前 subject identity；有 finding 时 origin Review 必须具备内容身份，verified finding 与对应 focused Review 必须同时绑定当前修复后身份。
- 旧 Workflow v1 记录缺少该字段时由 schema 安全补为 `null`，可继续加载，但不能被视为当前 accepted。
- 最小回归覆盖：复用相同 `subject_id` 后改变 HEAD 时旧 full Review 失效；有 finding 的 focused verification 在 dirty identity 改变后失效；具备正确身份的两条 happy path 仍可 accepted。
- 验证：`node --test test/harness-workflow.test.ts` 8/8 passed；`npm run typecheck` exit 0；`git diff --check` exit 0（仅 Git LF→CRLF 提示）。未跑 full suite。
- 状态：SPEC-003 **fixed-unverified**；待 Emilia 从本次提交启动一次 fresh focused re-review。无 push、PR、GitHub 或部署动作。

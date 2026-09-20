# HARNESS-008 · Implementation Notes

## 来源与边界

- Ticket：`.local/HARNESS-008-ticket.md`；GitHub #48 仅作真实 tracker 引用，本轮不写入；fixed point / HEAD：`c801c879b64e97615d3e9575d667134ff62c11fb`。
- 已确认语义来自 `docs/specs/yuki-harness-v0.md` 70–88、94–115、117–128，`docs/design/yuki-harness-v0-handoff.md` 的“Recording 门禁”“控制边界”“测试 Seam”，以及 `docs/implementation-notes/HARNESS-004.md`。
- 本票只让 Harness 管理已经显式归属 Ticket 的 Codex run、owned task 和该 Ticket 的 worktree；不增加 start/send/task_start、自动续跑、服务管理或新的 Orchestrator 能力。

## Implementation Decisions

### 1. 增加一个 Ticket-bound control 边界，不复制执行状态机

- 新增轻量 `HarnessControls`，由 `Harness` 组合；它负责 Ticket/binding 校验、当前观察投影、控制记录和 UI action receipt。Codex 与 owned task 原实现仍分别是运行状态、输出、停止结果的 source of truth。
- `CodexSource` 在既有只读采集接口旁实现窄的 current-status/output/exact-stop adapter；`TaskSource` 同样只转接既有 `OwnedTasks.status/output/stop`。`TaskCollector` 继续只负责采集和历史，不成为第二个任务管理者。
- Ticket detail 的 controls 只由已持久化 binding 派生：run-scope 只含指定 run，session-scope 含该 session 已存在及后续被观察到的 run；task 只含 `TaskCollector` 已固定到该 Ticket 的 task。客户端不能提交任意 session、cwd 或 task 作为控制目标。

### 2. 当前观察状态与运行执行状态正交

- 每个 run/task control view 同时公开 `execution.status/error/finished_at` 与 `observation.state/observed_at/source/error`。观察源不可读、已过期或刷新失败只把 observation 标为 `unavailable | expired | unknown`；不得把它改写成 run/task `failed`。
- Codex 终态沿用 `completed | failed | stopped | timed_out | interrupted`；`queued | running | stopping` 非终态。owned task 的 `completed | failed | stopped` 才是已确认终态；`starting | running | stopping | unknown` 均不是停止完成。
- 刷新重新查询 YCA manager / owned-task source，并继续由 `scan(true)` 补采 durable events；失败时可显示最后一次持久 snapshot，但必须标为 historical/stale，不得冒充当前事实。浏览器重开、普通 GET、显式 refresh 都只观察既有 source，不调用 `start/send/task_start`，也不构造工程 prompt。

### 3. 停止必须精确绑定目标，request receipt 不等于 terminal

- Codex 停止 action 使用 `ticket_id + binding + session_id + run_id`。在 manager 内增加 exact-run guard：只有目标 run 仍是该 session 的 active run 才请求停止；若 active run 已变化，返回稳定冲突/非活动结果，绝不退化为“停止该 session 当前随便哪个 run”。已经 terminal 的目标返回 `already_terminal`，不触发新 stop。
- owned task 继续使用精确 `task_id`，但 action 前再次核对其持久 binding 属于当前 Ticket 和当前 source epoch；过期、不可用、错票分别显式返回，不能根据 cwd 推断归属。
- action receipt 只表达 `requested | request_failed | already_terminal` 及请求后的即时 source snapshot。`stopping`、tree-kill succeeded、HTTP 2xx 都不是终态证明；后续 refresh/采集到 source terminal 后才展示 confirmed terminal。停止不回滚已发生副作用，也不称为 pause/resume。

### 4. 控制记录 best-effort，但 recording 降级不阻断 manage-existing

- journal 增加兼容式 `control_action` 记录，至少含 control id、Ticket、action、精确 target、`requested/result` stage、outcome、source status、时间与完整性；只保存控制元数据和安全公开错误，不复制完整 output 或 prompt。
- journal 健康时先记录 intent，再调用 source，再记录 result；run 的后续终态仍由现有 `source.snapshot` / lifecycle event 证明，task 仍由既有 lifecycle/final 证明，不伪造第二份终态。
- refresh 属于 `observe`；run/task stop 与打开 worktree 属于 `manage-existing`。两类在 `recording-failed` / `collection-failed` 都可继续；若 intent 或 result 无法保存，响应与 UI 必须携带当次 `evidence_gap`。恢复 recording 不排队、不重放任何 refresh/stop/open action。

### 5. Worktree 只从 Ticket 事实解析

- 打开动作不接受客户端路径，只读取 `Ticket.expected_worktree`，每次按生产 allowlist/containment 规则 canonicalize，并确认它仍是存在的目录；缺失、越界或身份不符返回明确 unavailable/mismatch。
- 使用可注入的 Windows folder opener，生产实现以参数数组、`shell: false` 请求系统打开 canonical worktree；测试只核对被调用一次且参数为正确目录。进程启动成功只表述为 `open_requested`，不宣称窗口已经可见。

### 6. HTTP/UI 只增加窄的同源控制面

- 保留现有 loopback Host/Origin/SameSite/session 约束；POST 再使用每实例 CSRF token、严格 content type 和小型 body 上限。HTML form 成功后 303 回 Ticket；API 返回结构化 receipt。GET 保持无副作用观察语义。
- 最小公开 action：`POST /api/tickets/:ticket_id/refresh`、`POST /api/tickets/:ticket_id/runs/:run_id/stop`、`POST /api/tickets/:ticket_id/tasks/:task_id/stop`、`POST /api/tickets/:ticket_id/worktree/open`。服务端从 Ticket binding 解析其余身份；错票/错 binding 返回 404/409，不泄漏别票对象。
- Ticket 页面显示 observation freshness、execution status、输出/历史入口、停止回执和 evidence gap；只为非终态且当前可精确管理的对象显示 Stop。页面不出现创建任务、发送消息或“继续执行”入口。

## TDD seam

Primary seam 新增 `tools/codex-session-bridge/test/harness-controls.test.ts`，从公开 loopback HTTP/UI 驱动，复用真实 Harness journal、`SessionManager` 与 `OwnedTasks`，只替换 Codex executor、进程终止和 folder opener：

1. 关联已有 run/task，关闭并重开浏览器后刷新状态与已保存输出；核对 run/task 数量及 start/send 调用数不变，刷新没有 prompt 或重放。
2. 分别制造 source observation unavailable 与真实 execution failed，断言 UI/API 使用不同字段和措辞；恢复 source 后同一对象回到 current，不创建新 run/task。
3. 请求停止运行中的 Codex run，先得到 `requested + stopping`，再由真实 source lifecycle 收敛为 terminal；stop failure/active-run changed 不得显示 stopped，也不得误停同 session 的另一 run。
4. 对 Ticket-bound owned task 做同样的 requested、unknown/failure、confirmed terminal 检查；错票和旧 epoch 不调用底层 stop。
5. 在 `recording-failed` 下 status/output/refresh/stop 仍调用既有 source 并显示 gap；恢复后不自动重放。journal 可用时 requested/result 与最终 source lifecycle 可在重启后读取。
6. worktree open 只把 canonical `expected_worktree` 交给 injected opener；客户端路径、缺目录、越界目录及跨 Ticket target 均不启动 opener。
7. 验证 POST 的 session/CSRF/Origin/body 限制及 HTML 转义；页面和公开 API 不包含 start/send/resume 控件。

Secondary seam 只在主 seam 难以定位时补充现有 `bridge.test.js` exact-run stop guard、`tasks.test.js` 原停止状态机回归，以及 `harness-execution-gate.test.ts` 的 manage-existing/evidence-gap 分类。不要复制底层完整停止矩阵，不跑 full suite。

## 最小代码写集

- `tools/codex-session-bridge/src/harness/controls.ts`（新）与 `model.ts`：control view/action receipt、journal record 和精确 Ticket target 解析。
- `tools/codex-session-bridge/src/harness/{harness,codex-source,task-source,runtime,server}.ts`：组合 adapters、current projection、POST/UI、folder opener 注入；`task-collector.ts` 仅在需要安全查询 binding 时增加窄 lookup，不承担 stop。
- `tools/codex-session-bridge/src/manager.js`：为 Harness adapter 增加 exact active run guard，同时保持既有 `codex_stop_session(session_id)` 契约。
- `tools/codex-session-bridge/test/harness-controls.test.ts`（新），以及上述现有测试中的最小兼容断言。除非红测证明必要，不修改 `mcp.js` 公共工具集合、Codex executor、OwnedTasks 状态机、Control Center/Supervisor 或 Workflow/Changes/Conversation 模型。

## 实现顺序与 Deferred

1. 先写 public HTTP fixture 的断连/失败区分、exact stop、recording gap、不续跑和 worktree identity 红测。
2. 增加兼容 control record 与 source adapters，再实现 `HarnessControls` 的纯 target/state 组合和 exact-stop guard。
3. 最后接入 POST/HTML 与 folder opener，运行新增测试、受影响 Harness/bridge/task 定向测试及 typecheck；full suite 交给 Emilia + YCA 外层。
- Deferred：自动轮询/SSE/WebSocket、后台自启与跨进程重连（HARNESS-010）、服务管理（HARNESS-009）、新任务/真正续执行、通用多 Provider control adapter、编辑器选择和“窗口确实可见”的 OS 自动化证明。
- 无 Owner blocker；以上均沿用 Ticket/Spec/HARNESS-004 与现有 manager/task 公开语义，没有新的 Proposal。

## Context Plan

- **Core**：`.local/HARNESS-008-ticket.md`、本 Notes、`AGENTS.md`；`tools/codex-session-bridge/src/harness/{model,harness,codex-source,task-source,task-collector,server,runtime}.ts`；`tools/codex-session-bridge/src/{manager,mcp}.js`；`tools/codex-session-bridge/src/computer/tasks.js`；新增 `test/harness-controls.test.ts`。
- **Related**：`docs/implementation-notes/HARNESS-004.md`（gate/manage-existing）；Spec 70–88、94–115；handoff“Recording 门禁/控制边界/测试 Seam”；`test/{bridge,tasks,harness-tasks,harness-execution-gate}.test.*` 的 status/output/stop 先例。
- **Retrieval**：需要兼容旧 journal 时查 `recordSchema`/`Journal.append`；需要 HTTP fixture 时查 `browserFor`/Host-Origin-cookie；需要停止细节时查 `SessionManager.requestStop/stop/status/output` 与 `ComputerTask.stop/reconcile/snapshot`。
- **Expansion triggers**：exact-run guard 无法在不改变 MCP 契约下实现；task binding 无法从现有 collector/source 精确核验；Windows opener 不能使用 canonical allowlisted path；POST 安全要求迫使改变现有 loopback 会话模型。仅触发时扩读对应模块，不先引入 HARNESS-009/010 或完整历史。

The current ticket is ready for implementation.

## Implementation Handoff（2026-09-20）

- 来源：GitHub #48 的本地快照 `.local/HARNESS-008-ticket.md`、本文件 Implementation Decisions / TDD seam、fixed point `c801c879b64e97615d3e9575d667134ff62c11fb`；implementation start HEAD 为 `1b356610b297b884468ea4d16405005b825d71c0`。
- 身份：worktree `C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-008`，branch `codex/yuki-harness-v0-008`。本 session 按 Owner 要求未 commit；当前实现与测试字节均为未提交工作区内容。
- 范围：新增 `src/harness/controls.ts` 的 Ticket-bound run/task/refresh/worktree 控制投影与 receipt；为 `CodexSource` / `TaskSource` 增加窄 current/exact-stop adapter；为 `SessionManager` 增加 `stopRun(sessionId, runId)` exact active-run guard，同时保留 `codex_stop_session(session_id)` 的旧公共契约；journal 增加兼容 `control_action` intent/result；loopback HTTP/UI 增加四个限定 POST、每实例 CSRF、Origin/session/content-type/body 上限、303 表单回跳及仅从 canonical `Ticket.expected_worktree` 打开的 folder opener。未修改 MCP 工具集合、Codex executor、OwnedTasks 状态机或 HARNESS-009/010/011 范围。
- 行为边界：execution 与 observation 分开；stop request、HTTP 2xx 或 tree-kill 请求不冒充 terminal；active run 改变时返回冲突且不停止新 run；recording 降级仍执行 observe/manage-existing 并返回 `evidence_gap`，恢复后不重放；页面/API 没有创建、发送、resume 或 continue 能力。
- TDD：首轮 `node --test test/harness-controls.test.ts` 在缺少 CSRF/POST/exact-stop seam 时红；实现后新增 public HTTP seam 覆盖不续跑、exact-run stop、observation unavailable 与 execution 分离、recording gap/no replay、canonical worktree、CSRF/Origin/session/content type、control record 重启可读。owned task seam覆盖错票、current epoch stop receipt、source terminal 收敛与旧 epoch 冲突。
- 定向验证：
  - `node --test --test-reporter=spec test/harness-controls.test.ts test/harness.test.ts test/harness-tasks.test.ts test/harness-execution-gate.test.ts`：exit 0，30/30 通过。
  - `node --test --test-reporter=spec --test-name-pattern="stop" test/bridge.test.js`：exit 0，5/5 通过。
  - `npm run typecheck`：exit 0。
  - `git diff --check`：exit 0；仅有 Git 的 LF→CRLF 工作区提示。
  - 按约定未运行 `npm test` / full suite；真实外层完整测试与 Acceptance 由 Emilia + YCA 执行。
- Review policy：`delegated`，接收方 Emilia / `engineering-workflow`；本 implementation session 未调用 `review` / `code-review`，primary Review 为 pending，不能据此宣称零 finding 或 Acceptance 通过。
- 当前未提交范围：`docs/implementation-notes/HARNESS-008.md`；`tools/codex-session-bridge/src/harness/{controls,codex-source,harness,model,runtime,server,task-collector,task-source}.ts`；`tools/codex-session-bridge/src/manager.js`；`tools/codex-session-bridge/test/{harness-controls,harness-tasks}.test.ts`。
- Commit：未提交（Owner 明确交由外层机械 Git 操作）。建议提交主题：`feat: 增加已有运行的 Ticket 控制面`。
- 下一步：Emilia 先以当前未提交字节为 review subject 启动 fresh primary Review；Review 后再由外层执行完整测试、Acceptance、commit/push 等后续授权内动作。Review 输入引用本 handoff、Ticket snapshot、fixed point/HEAD 与实际 diff，不传 implementation 聊天。

## Fresh Finding Fix Handoff（2026-09-20）

- 来源与身份：仅处理 `.local/workflow-state/HARNESS-008-review.md`（SHA-256 `9a47d73f09873bcd44d058869149998d690d6439ce31209128bdb228f97191c4`）列出的 4 条 finding；修复基线 subject digest `b4c64460060ec1bcb5e063c36e810a642d97e91e2ac8b82313c9a9e9dfae7491` 已由 Primary Review revalidate 为 matched。worktree、branch、fixed point 与 HEAD 仍分别为本文件上一 handoff 所列值、`codex/yuki-harness-v0-008`、`c801c879b64e97615d3e9575d667134ff62c11fb`、`1b356610b297b884468ea4d16405005b825d71c0`；本轮仍未 commit。
- `STD-001 / SPEC-003`：**fixed，pending fresh focused verification**。`CodexSource.worktree` 每次 open 都重新走既有 `PathPolicy` canonical allowlist，确认目标当前仍是 directory，并用登记时 comparison baseline 核对 worktree root、repository common-dir 与 repository instance identity；普通文件/不可读目标稳定返回 `WORKTREE_UNAVAILABLE`，同路径替换为另一仓库稳定返回 `WORKTREE_MISMATCH`。保留 `explorer.exe` 参数数组、`shell:false`，未增加编辑器选择或服务管理。
- `SPEC-001`：**fixed，pending fresh focused verification**。run `request_failed` 和 owned task 同步 `termination.error` / `tree_kill=failed` 统一成为公开 `request_failed`，JSON 与 form 均返回 503 结构化结果且 form 不再 303；`stopping` 仍为 202 accepted/in-progress，未冒充 terminal。未修改旧 MCP `codex_stop_session(session_id)` 契约，也未修改 OwnedTasks 状态机。
- `SPEC-002`：**fixed，pending fresh focused verification**。recording-failed 时 control current/refresh 通过 `TaskCollector.currentStatus` 直接只读查询现有 `TaskSource.observation`，绕过 journal save/apply；公开 projection 只使用 `current` / `unavailable` / `unknown`，同时保留 recording `evidence_gap`。恢复或重复 refresh 不重放 stop/control。
- TDD 红灯：worktree open 定向测试初次为 1 pass / 2 fail（文件替换实际 202、仓库身份替换实际 202）；run stop failure 与 task 同步 STOP_FAILED 初次各 0/1（实际 200 与 202）；recording-failed terminal refresh 初次 0/1（实际仍显示 `running`）。随后只做上述最小实现转绿。
- 最终定向验证：`node --test test/harness-controls.test.ts test/harness-tasks.test.ts` exit 0，21/21；`npm.cmd run typecheck` exit 0；`git diff --check c801c879b64e97615d3e9575d667134ff62c11fb..HEAD`、`git diff --cached --check`、`git diff --check` 均 exit 0，仅有既存 LF→CRLF 工作区提示。按 Owner 指示未运行 `npm test` full suite。
- 未触碰边界：未改 MCP 工具集合、Codex executor、OwnedTasks 停止/终态状态机、编辑器/服务管理、HARNESS-009/010/011；未执行 Review、Acceptance、commit、push 或 GitHub 写入。
- Review policy：`delegated`，接收方 Emilia / `engineering-workflow`。下一步仅由上层针对这 4 条 finding 启动一次 fresh focused re-review；本 handoff 不声称 Review 或 Acceptance 通过。

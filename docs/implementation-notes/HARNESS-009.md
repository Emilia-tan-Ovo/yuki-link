# HARNESS-009 · Implementation Notes

## 来源与边界

- Ticket：`.local/HARNESS-009-ticket.md`；Source Spec：`docs/specs/yuki-harness-v0.md` 23、59–60、84、87–90、105、111；fixed point / HEAD：`a325873a2c15c75ce3ee8bf3a169deb795e757fc`。
- 当前事实来自 `tools/control-center/README.md` 及 `src/{supervisor,main,server,units}.js`，Harness 入口来自 `tools/codex-session-bridge/src/{main.js,harness/server.ts,harness/runtime.ts}`。GitHub #49 本轮不写入。
- Owner 已确认：由现有 Control Center/Supervisor 宿主精简的 Harness 日常服务管理页面；YCA 内当前 Harness 只提供导航入口；原 Control Center 完整页面保留为高级维护入口。不拆出独立常驻 Harness Runtime。

## Implementation Decisions

### 1. 唯一管理宿主与页面 seam

- Control Center 进程继续是 YCA、tunnel、release、ownership、recovery 的唯一管理宿主。新增同源日常页面（建议 `/harness/services`）只投影 `Supervisor.snapshot()` 并调用现有 `Supervisor.action(...)` / `updateDeployment(...)` interface，不复制 stop/start、ownership、活动任务、回退或恢复规则。
- 当前 YCA 内 Harness 不代理管理请求，因为 stop/restart/update 会终止其宿主进程。它只显示由 Supervisor 启动参数注入并严格验证的 loopback 日常页面链接；未由 Supervisor 启动、链接缺失/非法或不可达时显示 unavailable，不猜测默认端口。
- 链接只允许 `http://127.0.0.1:<port>/harness/services`，不携带 cookie、CSRF、token 或配置路径。浏览器进入 Control Center 后重新取得该进程自己的 SameSite session。禁止 CORS、iframe、跨进程凭据共享及 Harness journal 代管服务状态。
- 日常页面沿用 Control Center 的 exact Host/Origin、session、CSRF、JSON body 上限和 CSP。页面提供“打开 Control Center 高级维护”链接；autoRecovery、登录自启、prepare-only、诊断与人工工具确认等高级入口不复制到日常页面。

### 2. 状态契约直接投影 Supervisor 当前事实

- 整体 `observed_at` 取当前 snapshot 的 `at`；每个 YCA/tunnel 观察保留 `source` 与自身观察时间。超过 Supervisor 既有 freshness 窗口、时间缺失或 `running` 为 `null/undefined` 时标为 `stale` 或 `unknown`，可保留上次值作为历史提示，但不得作为当前成功、健康或版本相等证据。
- YCA release 三层分别为：`running = units.yca.deployment.running.commit`、`selected = ...target.commit`、`remote = ...latest.commit`。remote 只有 `latest.stale === false` 时为当前远端事实；检查失败保留旧值并明确 stale/error。`restartRequired`、`remoteDiffers` 保持 `true | false | null`，证据不足时不得推导。
- `versions.controlCenter/node/yca/tunnel` 是软件版本；YCA 的 running/selected/remote commit 是 release 身份，二者不得混写。tunnel 没有 selected/remote release，展示其软件版本、running/owned/health、control-plane 与 communication evidence 即可。
- YCA/tunnel 均展示 `running: true | false | unknown`、`healthy`、`status`、`owned`、`desired`、`blocked/code` 和 freshness。`running=true, owned=false` 是外部实例，只观察；页面不得自行判断可接管。tunnel 本地 live/ready、proxy reachability 与近期通信证据分层展示，不能推出 ChatGPT 端到端可用。
- `busy` 非空时页面禁用重复动作；Supervisor 的 `serial()` 仍是并发事实来源。`activity` 为空表示 unknown，不是 idle；有任一计数大于零表示 active。`observeOnly` 时动作禁用且服务端继续拒绝。
- `autoRecovery` 只读显示当前值。打开/刷新/离开 Harness 日常页面均不得调用 `setRecovery` 或改 desired state；高级页面仍保留原开关。

### 3. 动作契约全部经过现有 Supervisor interface

- `start(target)` 使用 `Supervisor.action(target, 'start')`；target 仅为既有 `yca | tunnel | all`。YCA 已停止时启动 selected release；tunnel 仍要求 YCA healthy。只有启动观察达到既有 healthy 条件才返回成功。
- `stop(target)` 使用 `Supervisor.action(target, 'stop', confirm)`；`all` 仍按既有依赖逆序停止。Supervisor 重新观察 activity/ownership；停止超时、诊断失联、所有权变化或未知活动均失败，不降级为强杀。
- `restart-current(target)` 映射既有 `action(target, 'restart', confirm)`，不新增 restart 实现。包含 YCA 时先锁定当前 running commit，再重启同一 release；selected 已变化也不得偷偷切换。当前 release/ownership 无法确认时失败。
- `update-and-restart` 只映射既有 `updateDeployment(prepare, { restart: true, confirm })`：准备候选后再次检查 activity、running release、PID/creation identity 与 ownership，再切换并验证 running commit/tool summary；失败沿用既有有限回退，回退冲突或失败必须原样报告。它不是普通 restart，也不隐式升级 Supervisor/tunnel。
- `confirm=true` 仅表示用户针对本次动作确认可能中断活动任务；UI 必须先显示影响说明。它不绕过 ownership、observeOnly、release identity、readiness 或回退检查，也不持久化为以后动作的授权。update 在 prepare 后的最终检查继续使用同一次明确确认。

### 4. HTTP、失败与结果未知

- 复用现有 `/api/action` 和 `/api/deployment`，不再建立一套 service-management endpoint。请求增加一次性 `operation_id`（UUID，由页面在发送前生成；仅用于关联，不是幂等键，客户端不得因超时自动重试）。服务端继续严格拒绝额外字段和非固定 action/target。
- Supervisor 完成动作及最终 observe 后，HTTP 200 才返回 `ok: true`、`operation_id`、`outcome: succeeded`、完成时间和最新 snapshot。Supervisor 抛出的稳定错误继续返回非 2xx、`ok: false`、同一 `operation_id`、`outcome: failed` 与安全 error code；更新已回退到旧 release 仍是本次 update failed。
- 浏览器未取得合法响应、连接在动作期间断开、Supervisor 重启或只有 requested event 而没有 terminal event时，结果为 `unknown`。UI 只能刷新当前 status/events 协助核对，不能显示成功，也不能自动重发。当前 snapshot 是当前状态事实；operation receipt/events 是动作轨迹，二者不互相替代。
- 既有 400（无效输入）、403（session/Origin/CSRF）、405（方法）保持；Supervisor 领域错误的精确 HTTP 4xx/5xx 分组可在实现中按现有兼容性选择，body 的稳定 code/outcome 才是页面判断依据。

### 5. 管理结果追踪保持在 Control Center

- Control Center 在真正调用 Supervisor 前写一条 bounded metadata `requested` event，结束后写 `succeeded | failed` terminal event；字段限于 `operation_id/action/target/outcome/code/at`，不记录 token、命令输出或用户内容。
- 扩展现有 `Events` 的兼容读取/投影，使 operation events 及当前已有 deployment checked/prepared/switched/rollback/failure 事件在 Supervisor 重启后仍可从既有 `events.jsonl` 有界恢复；保留当前条数/轮转策略，不建设新 Event Store。
- `Supervisor.action` / `updateDeployment` 是写 terminal event 的责任模块；HTTP 页面只传 operation context 和展示 receipt，避免“HTTP 成功”和“Supervisor 实际结果”形成两套判断。没有 terminal event 的 requested 操作显示 unknown。
- 不写 Harness journal `control_action`：YCA 停止期间该 writer 不存在，而且 #49 的 source of truth 是 Control Center。此处只提供服务运维轨迹，不承诺长期工程事件保存。

## 最小测试 seam

- Primary：`tools/control-center/test/server.test.js` 从 loopback HTTP 驱动日常页面与现有 action/deployment 路径，验证同源安全、固定输入、operation receipt、failed/unknown 不显示成功、advanced link，以及页面加载/刷新不调用 recovery。
- Supervisor 定向：在 `tools/control-center/test/supervisor.test.js` 增加 operation requested/terminal 与重启恢复断言；复用既有 activity protection、restart pins running release、update recheck、ownership loss、rollback conflict、stale remote tests，不复制 recovery budget、长间隔、断网或压力矩阵。
- Harness 集成：在 `tools/codex-session-bridge/test/harness.test.ts` 或窄的新测试中验证 Supervisor 注入的合法 loopback 链接可见，缺失/非法时 unavailable，Harness 页面没有本地 service POST/autoRecovery 控件；无需真实停止承载测试进程。
- 只在参数装配无法由上述 seam 覆盖时，对 `tools/control-center/test/manager-process.test.js` 增加一条隔离启动参数断言。实现模型只跑新增与受影响定向测试和 bridge typecheck；Control Center/bridge full suite 由外层确定性执行，不重跑无关恢复压力矩阵。

## Implementation Sequence

1. 先写 Control Center 日常页面/receipt 与 Harness 导航的公开红测，固定状态 freshness、unknown 和安全语义。
2. 在 Control Center 内增加 operation context/events 投影，复用原 Supervisor methods 完成四类动作；补齐既有 deployment events 的兼容恢复。
3. 由 Supervisor 启动 YCA 时注入受限日常页面 URL，Harness 只渲染导航/unavailable；补文档并运行定向测试与 typecheck。

## 预计直接写集

- Control Center：`tools/control-center/src/{server,supervisor,common,main,units}.js`；`tools/control-center/public/` 下新增精简日常页面资源，必要时复用 `style.css`；`tools/control-center/README.md`。
- Harness 导航：`tools/codex-session-bridge/src/main.js`、`tools/codex-session-bridge/src/harness/server.ts`；不预计修改 `harness/controls.ts`、journal/Event Store、manager/executor 或 MCP 工具集合。
- 测试：`tools/control-center/test/{server,supervisor}.test.js`、`tools/codex-session-bridge/test/harness.test.ts`；`manager-process.test.js` 仅在启动参数装配需要时修改。

## Deferred Details

- 日常页面资源采用单独 HTML/JS 还是 server-rendered HTML、字段展示顺序和中文短文案，按现有 Control Center 风格在实现中决定，不改变上述状态/动作契约。
- 不做 SSE/WebSocket、跨进程代理、独立 Harness resident、长周期操作库、Event Store 迁移、autoRecovery/startup 管理或真实断网/待机压力验收；这些都不是 #49 的阻塞项。
- GitHub tracker 的 Notes 同步由 Emilia/YCA 外层完成；本轮禁止外部写入。

## Implementation Handoff（2026-09-20 replacement implementation）

### 来源与身份

- 来源：`.local/HARNESS-009-ticket.md`、本 Implementation Notes、`docs/specs/yuki-harness-v0.md` 的服务管理/动态状态/testing seam，以及 `tools/control-center/README.md` 的对应运行语义。
- worktree：`C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-009`；branch：`codex/yuki-harness-v0-009`。
- fixed point：`a325873a2c15c75ce3ee8bf3a169deb795e757fc`；开始与当前观察 HEAD：`76c222b87027fb85de50e4702f3af3015c7fb7fa`。
- 当前为未提交实现工作树；未读取 global Memory、`.workflow/history/**`、旧 HARNESS Review/Acceptance/closeout 或完整 Git history。

### 实际范围与写集

- Control Center 日常页：新增 `tools/control-center/public/services.html`、`services.js`，并在 `src/server.js` 提供同源 `/harness/services`。页面直接展示 Supervisor snapshot 的 observation freshness、running/healthy/owned/desired/activity、YCA running/selected/remote release、tunnel 分层证据及只读 autoRecovery；提供 start/stop/restart-current/update-and-restart，并保留完整 Control Center 高级维护入口。
- 唯一管理路径：`src/{server,supervisor,main,units,common}.js` 只把动作转交既有 `Supervisor.action(...)` / `checkDeployment(...)` / `updateDeployment(...)`；没有新增第二套管理状态机、recovery 开关或 Harness service POST。
- operation 追踪：`/api/action` 与 `/api/deployment` 严格要求一次性 UUID `operation_id`；Supervisor 在既有 bounded `events.jsonl` 写 requested 与 succeeded/failed terminal 元数据，兼容恢复 operation 及已有 deployment 事件。合法响应返回 correlated receipt；daily UI 对断连只显示 unknown，不自动重发。
- Harness 导航：`tools/codex-session-bridge/src/{main.js,harness/server.ts}` 接收 Supervisor 注入的 URL；只允许精确 `http://127.0.0.1:<port>/harness/services`，以短超时只读探测决定渲染导航或 unavailable，不代理 POST，也不传 cookie/token/config path。Control Center 仅允许无 Origin 的 same-site GET 顶层 document 导航进入页面，API 安全检查保持不变。
- 兼容调用方与文档：更新完整 Control Center `public/app.js` 生成 operation ID；更新 `tools/control-center/README.md`；更新 `test/{server,supervisor,manager-process}.test.js` 与 bridge `test/harness.test.ts`。`manager-process.test.js` 只同步新 HTTP 输入契约，本轮未执行其完整进程生命周期测试。

### TDD 与验证

- 红灯先固定并逐条转绿：daily route/receipt；Supervisor action requested/terminal + 重启恢复；Harness 严格 loopback 导航；严格 operation input/failed receipt；deployment terminal；daily UI 动作与只读 recovery；不可达链接 unavailable；跨端口顶层导航。
- `node --check`：受影响 Control Center source/public JS 与 bridge `src/main.js`，exit 0。
- `node --test tools/control-center/test/server.test.js`：3/3 pass，exit 0。
- `node --test --test-name-pattern="service operations record|deployment operations keep|prepared release stays|update-restart rechecks|failed candidate start|failed remote check|pre-switch|rollback" tools/control-center/test/supervisor.test.js`：10/10 pass，exit 0。
- 在 `tools/codex-session-bridge`：`node --test --test-name-pattern="validated loopback|malformed request-target" test/harness.test.ts`：2/2 pass，exit 0。
- 在 `tools/codex-session-bridge`：`npm run typecheck`（`tsc --noEmit`），exit 0。
- `git diff --check`：handoff 写入后再次通过，exit 0；仅有仓库现有 LF→CRLF 提示。
- 按 Owner 指令未运行 full suite、Control Center 完整 manager-process 生命周期、真实服务停止/重启/更新、真实浏览器交互或 ChatGPT 端到端；因此本 handoff 只声明代码实现与定向自动化通过，不声明 Acceptance 或日常 stable。

### Review policy、风险与 Commit

- `review_policy: delegated`；接收方为外层 Emilia + YCA，fresh primary Review 尚未执行，当前不作 finding 数量或 Review 通过声明。
- 已知未验证项：Supervisor→YCA 的真实进程参数装配仅由代码路径核对，未运行长时 manager-process 测试；daily UI 未做真实浏览器点击；正式服务 update/rollback 未在本机触发。
- Owner 明确要求本 session 不 commit/push/review；当前没有新 commit，HEAD 仍为 `76c222b87027fb85de50e4702f3af3015c7fb7fa`。
- 建议中文提交主题：`feat: 接入 Harness 日常服务管理页`

### Outer validation 与 baseline follow-up（2026-09-20）

- HARNESS-009 当前受审工作区**不修改** `tools/control-center/test/deployment.test.js`；该测试的二次 prepare `DEPLOYMENT_PROBE_FAILED` 已确认是默认基线可独立复现的旧 fixture 问题，并已单独登记 GitHub #68，本票不吞并该 maintenance。
- 当前 #49 生产改动下，外层 Control Center full suite 的有效观测为 38/39，唯一稳定红项为上述 #68；同一红项定向复现，且 clean base 对照也复现，因此不归因于 #49。另一次并行 full-suite 的 Codex discovery 超时已隔离重跑 1/1 通过，不作为 #49 regression。
- Bridge full suite：171 total / 170 pass / 0 fail / 1 existing opt-in local Skill read skip；bridge typecheck 通过；当前 subject 的 `git diff --check` 通过。
- Reviewer/Acceptance 必须把 #68 作为已知 baseline evidence gap，不得把它误写成 HARNESS-009 已修复，也不得用“full suite 全绿”描述当前 #49 字节。

### 下一步

- 外层先以本 handoff、当前完整 diff 和上述测试证据启动 fresh delegated Review；Review 后再由 Emilia 执行 Acceptance 所需的确定性核对。不要把 HTTP receipt、定向测试或本 handoff 直接升级为 Acceptance 通过。

## Context Plan

- **Core**：`.local/HARNESS-009-ticket.md`、本 Notes、`AGENTS.md`；`tools/control-center/src/{supervisor,server,main,units,common}.js`、`public/{index.html,app.js}`、`test/{server,supervisor}.test.js`；`tools/codex-session-bridge/src/{main.js,harness/server.ts,harness/runtime.ts}` 与 `test/harness.test.ts`。
- **Related**：`docs/specs/yuki-harness-v0.md` 上述服务管理/动态状态/testing seam；`tools/control-center/README.md` 的 running/selected/remote、restart/update、ownership/activity/autoRecovery；`docs/implementation-notes/HARNESS-008.md` 仅用于“不把 HTTP receipt 冒充终态”的先例。
- **Retrieval**：需要启动参数时查 `YcaUnit.start`；需要状态字段时查 `Supervisor.snapshot/observe/currentYcaCommit`；需要失败/回退时查 `guardImpact/action/updateDeployment/rollbackDeployment`；需要安全路由时查两个 `server` 的 Host/Origin/session/CSRF 逻辑。
- **Expansion triggers**：只有既有 Supervisor interface 无法表达某个确认动作、operation terminal 无法在 Control Center 内可靠落盘，或参数注入迫使读取/传递凭据时扩大调查；否则不读取完整历史或引入新进程拓扑。

The current ticket is ready for implementation.

## Finding Fix Handoff（2026-09-20 primary Review v2）

- `SPEC-001`：Supervisor 现在只在 service/deployment 的最终 persist + observe 完成后写 terminal event；terminal 写入或最终收尾失败会携带 `operationOutcome: unknown`，HTTP 返回同一 `operation_id` 的 `outcome: unknown`，不再合成 failed/succeeded。operation event 也改为成功 append 后才进入内存投影。
- `SPEC-002`：daily `services.js` 与 advanced `app.js` 均保留本次生成的 `operation_id`，只接受 ID 严格匹配、合法 `succeeded | failed` 且与 HTTP status 一致的 receipt；其余情况显示/抛出 unknown，且不自动重试。
- `SPEC-003`：advanced event 列表按 operation schema 显示 `operation_id / action / target / outcome / code`，旧 `component / action / code / exitCode` 显示保持兼容。
- TDD/验证：新增 final persist、terminal writer、HTTP unknown 故障注入，以及 daily/advanced mismatch/missing receipt 与新旧 event display seam。定向结果：Supervisor 6/6、server 4/4、public UI 2/2；受影响 5 个 JS `node --check` 均通过；`git diff --check` 通过（仅既有 LF→CRLF 提示）。未运行 full suite。
- 本轮实际写集：`tools/control-center/src/{supervisor,server,common}.js`、`tools/control-center/public/{services,app}.js`、`tools/control-center/test/{supervisor,server,public-ui}.test.js`、本文件。
- 已知限制：未做真实浏览器点击、真实服务启停/更新或 full-suite 验收；#68 baseline note 保持原样，本轮不处理 #68。当前仍为未提交工作区，未 commit/push/review。

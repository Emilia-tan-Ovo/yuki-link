# BUGFIX-108 Implementation Notes

- Source Ticket：[GitHub #108](https://github.com/Emilia-tan-Ovo/yuki-link/issues/108)；观察来源 #102 closeout。
- Fixed point：`ba0995686d6939b0fbc917414994605f87aa3bb7`；设计 worktree：`.local/worktrees/bugfix-108`。
- 本轮授权：仅 ticket-design。后续实现需 fresh session，从本 Notes 与 Git 事实恢复。

## 根因与复现入口

`tools/codex-session-bridge/src/harness/server.ts` 仅对 `StaticAssets.get('/')` 返回的成功 SPA index 响应设置 `yuki_harness` cookie。`StaticAssets` 默认读取 `tools/codex-session-bridge/dist/harness-ui/`；缺少构建时首页返回 503 `UI_BUILD_UNAVAILABLE`，`index=false`，因而没有 `set-cookie`。当前 clean worktree 没有该产物；Node 24 对默认 `StaticAssets().get('/')` 的只读探测得到 `status=503, body=UI_BUILD_UNAVAILABLE, index=false`。`harness-workflow.test.ts` 和 `harness-conversations.test.ts` 的 fixture 直接启动 UI 并读取 cookie，未准备 UI 资源，也未检查首页状态。`package.json` 的 `pretest` 仅在执行 `npm test` 时构建 UI；直接运行 `node --test ...` 不会触发它。因此根因是测试入口依赖未声明的构建产物，非生产 cookie / CSRF / SameSite 语义异常。

另一个生命周期缺口：两个 fixture 都在连接 MCP、启动 UI、取首页之后才返回 `close`；若初始化中途抛错，测试的 `t.after(f.close)` 尚未注册，已打开的 listener、client、Harness 和临时目录可能残留。

## Implementation Decisions / Plan

1. 在 `tools/codex-session-bridge/test/fixtures/` 提供测试专用的最小合法 UI 资源：临时 `index.html`、Vite 形状的 manifest 与 allowlisted hashed asset。让两个目标 fixture 通过现有 `createHarnessServer(..., { uiRoot })` 注入该目录，使直接定向测试不依赖仓库构建产物；只服务 cookie/API 测试，真实 SPA 打包和安全约束仍由既有 `harness-ui-server.test.ts` 覆盖。不得给生产 server 增加缺构建时的 cookie fallback。
2. 两个 fixture 在读取 cookie 前明确断言首页 `200`、cookie 存在且保留 `HttpOnly; SameSite=Strict; Path=/`；错误应报告首页状态与资源初始化问题，而不是对 null 调用 `split`。保持现有 cookie/CSRF 请求流程。
3. 将 fixture 初始化与关闭安排为对称生命周期：初始化任一步骤失败也关闭已创建的 client/listener/Harness，并移除自身临时目录；正常 `t.after` 关闭可重复调用，不留后台 listener。关闭时先停止连接与服务，再删目录。只修改测试基础设施。
4. 新增定向回归，覆盖无预构建 `dist` 时 fixture 首页仍正常发 cookie、目标测试走到原有断言，以及初始化中途失败和正常关闭后资源可释放。注入失败的具体测试钩子属于局部实现细节，不扩展为通用框架。

## 测试计划

- 先在无 `dist/harness-ui` 的 clean worktree 运行：`node --test test/harness-workflow.test.ts test/harness-conversations.test.ts`（cwd `tools/codex-session-bridge`）；旧 fixture 应在 cookie 读取处复现，新 fixture 应通过并执行真实断言。
- 定向运行新增的初始化失败/正常关闭回归；验证临时目录和监听端口释放，避免测试因 bootstrap 异常提前中止。
- `npm run typecheck`；如需验证真实 SPA 契约，先按现有脚本 `npm run build:ui`，再运行 `node --test test/harness-ui-server.test.ts`。完整套件由上层工作流按验收需要执行，不在设计阶段运行。
- 检查 `git diff --check` 与实际写集；确认 `src/harness/server.ts`、`static-assets.ts` 和 `tools/control-center` 未改，生产安全语义不变。若事实显示必须修改生产 cookie / CSRF / SameSite，停止并作为 blocker 请 Owner 决定。

## 写集边界与 deferred details

- 预计实现文件：`tools/codex-session-bridge/test/harness-workflow.test.ts`、`tools/codex-session-bridge/test/harness-conversations.test.ts`、`tools/codex-session-bridge/test/fixtures/` 下的测试辅助文件；本 Notes 仅记录设计。确需新增同目录回归测试文件时仍限于 `tools/codex-session-bridge/test/`。
- 不触碰 `tools/control-center`、生产 cookie / CSRF / SameSite、安全路由或无关 fixture；其他同样直接读取 cookie 的测试仅记录为后续范围判断，不因本票批量改写。
- 辅助函数名、失败注入钩子形状、测试文件拆分由实现阶段按现有约定决定。

### Context Plan

- Core：GitHub #108 验收、根 `AGENTS.md`、本 Notes、fixed point 与当前 Git 状态；`tools/codex-session-bridge/package.json`、`src/harness/server.ts`、`src/harness/static-assets.ts`、`test/harness-workflow.test.ts`、`test/harness-conversations.test.ts`。
- Related：`tools/codex-session-bridge/test/harness-ui-server.test.ts`（真实 SPA / cookie 与缺构建安全契约）、`tools/codex-session-bridge/vite.config.ts`（manifest 形状）、`docs/specs/yuki-harness-v0.md` 的测试和安全边界。
- Retrieval：#102 closeout、其他 Harness 测试、历史 HARNESS tickets 默认冷读；只有当前证据不足时按 `UI_BUILD_UNAVAILABLE`、`set-cookie`、`uiRoot` 定位片段。
- Expansion triggers：若注入测试资源不能复用现有 UI root seam、服务器关闭顺序仍泄漏、或修复要求变动生产安全行为，扩大调查并将安全变动作为 blocker。

设计决定均由现有 Ticket、代码与既有安全契约确定；无待 Owner 选择的实现方向。Ready for fresh implementation；本轮不执行实现。

## Implementation Handoff（2026-09-23）

- 来源：GitHub #108；本 Notes 的 Implementation Decisions；`docs/specs/yuki-harness-v0.md` 的测试与安全边界。
- 身份：worktree `.local/worktrees/bugfix-108`，branch `codex/bugfix-108-harness-cookie-fixture`；fixed point `ba0995686d6939b0fbc917414994605f87aa3bb7`；开始 HEAD `e4d2c5eff09f9ea4e16140b4d48b5bfb9ab0f25f`。实现提交的精确 SHA 由 post-commit checkpoint 和交回结果定位。
- 实现：仅改两个目标测试及新增 `test/fixtures/harness-ui.ts`。测试 UI helper 在临时目录创建合法 index、manifest 与 allowlisted asset，并通过既有 `uiRoot` 注入；首页先确认 200 和完整 `yuki_harness` cookie 属性。两个 fixture 的初始化失败和正常关闭共用幂等清理，先关 client/listener/Harness，后移除临时目录；局部失败注入回归验证服务和目录释放。
- 红灯：无 `dist/harness-ui` 时，原定向测试在首页 cookie 读取处失败，进程因 fixture 初始化失败未清理而挂起，手动中止；修复前环境探测为无该目录。
- 绿灯：在同一无 UI 构建产物的 worktree 中执行 `node --test test/harness-workflow.test.ts test/harness-conversations.test.ts`，exit 0，20/20 通过，包含两个新增生命周期回归和原有业务断言；`npm.cmd run typecheck` exit 0；`git diff --check` exit 0。完整 `npm test`、真实 SPA 构建与其 UI 测试未由本 implementation session 执行。
- Review policy：delegated，由 Emilia 在 fresh session 启动 Review；本 session 未自审，Review 与 Acceptance 均 pending，无 finding 结论。
- 范围与风险：生产 `src/harness/server.ts`、`static-assets.ts`、`tools/control-center` 均未修改。测试资源只证明 fixture 的 cookie/API 入口；真实 SPA 契约仍依赖上层后续验收。交接后由 Emilia 核对 commit、执行 fresh Review 与必要验收；本 session 不 push、不建 PR、不 merge。

## Finding Fix Handoff（2026-09-23）

- 来源：`.local/workflow-state/BUGFIX-108-review.md` 唯一 P2；修复基线 `a58a0afa66c133ba25ba7dc371a4cdab945528a6`。仅处理两个 fixture 的 `server.listen()` 绑定失败路径。
- 修复：`test/fixtures/harness-ui.ts` 增加共用 `listenFixtureServer`，同时订阅 `listening` 与 `error`，成功、失败及同步抛错均确定性 settle 并移除监听器。两份 fixture 改用该 helper；绑定失败进入原有 `catch` 和幂等 `closeFixtureResources`，先关闭已启动服务，再删除临时目录。测试复用现有 close helper 关闭占位服务。
- 回归：两份 fixture 分别用真实 HTTP server 占用 UI 端口，在 MCP 已启动后触发 `EADDRINUSE`；断言 fixture reject、MCP/UI 不再监听、临时根目录不存在。无超时判断。原有初始化失败与重复关闭测试继续通过。
- 验证：`node --test --test-name-pattern='fixture .*端口绑定失败|fixture 初始化失败' test/harness-workflow.test.ts test/harness-conversations.test.ts`，4/4 pass；`npm.cmd run typecheck` exit 0；`git diff --check` exit 0。未运行完整 `npm test`。
- 范围：仅 Notes、上述两个测试与现有 test helper；生产 server、static assets、Control Center、MCP schema 零修改。等待一次 fresh focused re-review 和上层 Acceptance；本次不 push、不建 PR、不 merge。

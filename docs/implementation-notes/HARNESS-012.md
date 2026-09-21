# HARNESS-012 / GitHub #76 Implementation Notes

Source Spec: #39

Ticket: #76 — HARNESS-012：Conversation-first UI 产品化

Fixed point: `ea34e26f18ee89aa96401b8f57c43fd8527d8e16`

## Implementation Decisions

- **前端目录与构建**：production UI 源码放在 `tools/codex-session-bridge/ui/`；Vite 配置与独立 `tsconfig.ui.json` 留在该 package 根，产物固定到 `dist/harness-ui/`。保持 Node/Harness 与 UI 分开 typecheck，不把仓库改造成 monorepo。
- **依赖与发布**：React/Vite/UI 依赖全部精确锁定；`react-diff-view` 固定使用 prototype 已验证的 `3.3.3`。现有 release preparation 在 `npm ci --ignore-scripts` 后显式运行 `npm run build:ui`；deployment manifest 记录 UI 产物树 hash，`readDeployment` / `verifyDeployment` 拒绝缺失或被修改的 UI 产物。
- **Presentation 深模块**：新增 `presentation-model.ts` 定义共享 DTO/schema，`presentation.ts` 负责从 Harness domain facts / records 投影 Project、Ticket、Conversation 页面 DTO。Harness domain 不返回 UI DTO，HTTP routing 不解释 provider payload。
- **Provider-neutral UI**：`Participant` 使用稳定 id、语义 role、label 与可选 provider/model metadata；provider session/thread/run 作为不透明 `SourceRef`。当前 Codex payload 只在 projection 内部 mapper 解释，不预建通用 Provider adapter interface。
- **ConversationItem**：稳定语义 kind 至少覆盖 message / tool / lifecycle / workflow / control / task / unknown，并携带 participant、时间、cursor、source refs、integrity 与类型化 content。Unknown 必须保留对已持久化 record 再执行保护复制后的 `rawEvidence`；不能读取未保护 source payload，也不能静默丢弃未知事件。
- **Conversation 分页**：`ConversationHistory` 统一负责主/子 Conversation 记录选择与分页。接口形态为 `page(conversationId, { before?, after?, limit })`：默认返回最新页；before/after 互斥且均为 exclusive cursor；始终按 cursor 升序；默认 50、最大 100。响应返回 first/last/high-water cursor 与 has_older/has_newer。前端 prepend 后按首个可见 item id + pixel offset 恢复滚动锚点。
- **Changes 文件身份**：当前 Changes 文件投影增加不暴露路径正文的 `file_id` 与 `revision`。revision 覆盖 repository instance、Ticket baseline、current HEAD、path/old path/change kind 与内容身份/状态；worktree 变化后旧引用必须返回 stale。
- **Patch 深模块**：`ChangesSource` 负责 repository/worktree identity、containment、protected-path、Git/filesystem patch、redaction 与 size limit；`Changes` 负责重新读取当前 Changes、校验 file_id+revision 仍属于 Ticket 并投影公开状态；Harness 只做 Ticket lookup/delegation；HTTP 只做参数与状态码映射。
- **Patch HTTP contract**：`GET /api/tickets/:ticketId/changes/files/:fileId/patch?revision=...`。响应携带 baseline OID、current HEAD、checked_at、freshness、integrity、file identity 与 patch|null。tracked/rename 使用受限 unified git diff；untracked 生成标准 /dev/null unified patch。available/binary/deleted/protected/too-large/truncated 为结构化结果；stale→409，source unavailable→503，invalid→400，Ticket missing→404；全部 `no-store`，不返回 partial patch 冒充完整结果。
- **HTTP/static 分工**：`server.ts` 只组合 listener/session/security；API routing 移到 `routes.ts`，静态资源解析移到 `static-assets.ts`，presentation 独立。普通 GET 不执行 `scan(true)`；显式 refresh POST 与 background collector 保持事实刷新语义。
- **SPA 与安全**：只有 `GET /`、`/tickets/:uuid`、`/conversations/:uuid` 可 fallback 到 index，并建立 Harness session；`/api/**`、`/assets/**`、未知路径及非法编码/分隔符绝不 fallback。静态资源只从 Vite manifest allowlist + build-root containment 提供；hashed assets immutable cache，index/API/patch no-store。
- **Session / Composer seam**：增加 `GET /api/session` 暴露 CSRF token 与只读 `ComposerCapability`；现有 control POST 继续要求 session cookie、exact Origin、CSRF、content-type/body-limit。当前 Composer 只展示/保留只读能力槽位，不提供假输入或发送。
- **CSP**：保持 `default-src 'none'`，仅开放必要的同源 script/style/connect 和既有防护项，禁止 inline script / eval。
- **测试与验收**：自动测试覆盖 projection known/unknown、分页、patch 全状态与 stale/path safety、static traversal/fallback/cache/CSP/session/CSRF、GET-vs-refresh 扫描语义、release UI build/hash。最终必须在 production build + 真实 Harness server 上完成真实浏览器 Owner 视角验收。

## Implementation Sequence

1. 接入 package-local React/Vite 源码、共享 DTO、精确依赖与 production build。
2. 实现 presentation projection 与 frontend renderer registry，覆盖 known / unknown records。
3. 将主/子 Conversation 统一接入 latest / before / after 分页。
4. 为 Changes 增加稳定 file identity / revision 与安全 patch seam。
5. 拆分 HTTP routing / static serving，接入 SPA、session bootstrap、缓存与 CSP。
6. 将已确认 prototype 的布局、样式与 DiffViewer 接到真实 DTO/API。
7. 补齐定向测试、production build 与 deployment artifact hash 验证。
8. 在真实 Harness server 上执行 Owner 视角浏览器 Acceptance。

## Deferred Implementation Details

- 局部文件名、CSS token、React hook/helper 和 renderer 内部拆分按实现期项目约定决定。
- 除 `react-diff-view@3.3.3` 外的前端精确版本，从已验证 prototype lock 选择并写入正式 lockfile。
- 滚动锚点 helper、patch size 常量及错误文案为低风险实现细节，但不得改变已固定的接口/状态语义。
- 大 diff virtualization、完整 syntax highlighting、Composer 写入能力、DeepSeek/第二 Provider adapter 继续 deferred。

### Context Plan

- **Core**: GitHub #76；根 `AGENTS.md`；`docs/design/yuki-harness-v0-handoff.md` 的 UI 产品化 / Conversation / Changes / 控制 / 测试段；`tools/codex-session-bridge/src/harness/{server,harness,model,conversation-model,conversations,changes,changes-source}.ts`；对应 harness tests。
- **Related**: `docs/specs/yuki-harness-v0.md` 的 Conversation / Changes / security / UI 条款；`src/harness/{journal,content-policy,runtime}.ts`；`src/main.js`；package / tsconfig；Control Center deployment source/tests；prototype 的 `DESIGN-NOTES.md`、`App.jsx`、`DiffViewer.jsx` 只作已确认视觉/交互参考。
- **Retrieval**: 定向检索 `scan(true)`、cursor、`protectedCopy`、`comparison_baseline`、`repository_instance_id`、`createHarnessServer`、`prepareDeployment`、manifest/hash、Host/Origin/Sec-Fetch/CSRF。
- **Expansion triggers**: release build 无法保持 immutable deployment；真实 Codex payload 超出现有 mapper 证据；Git for Windows 无法安全生成 rename/untracked patch；真实浏览器发现 Vite asset/CSP/session bootstrap 冲突。仅触发时扩查，不重开产品决策。

## Ready

Implementation frontier 已收敛，无设计 blocker。Implementation 必须使用 fresh model session，从本 Notes + #76 + fixed point 开始，不复用 ticket-design session。

## Implementation Handoff — 2026-09-21

### 来源、身份与授权终点

- 来源：GitHub #76 完整正文、本 Notes、根 AGENTS.md、Design Handoff 的 UI/Conversation/Changes/控制/测试段。
- Worktree：`C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-012`；分支：`codex/harness-012-ui-productization`。
- 开始 fixed point / HEAD：`ea34e26f18ee89aa96401b8f57c43fd8527d8e16`。入口已有的 Design Handoff、Ticket README 和本 Notes 为 Owner 确认的 planning delta，保留并随本票提交。
- `review_policy: delegated`；本 session 未执行 primary Review。接收方为外层 fresh reviewer；完整测试套件与 production browser Acceptance 由外层 Emilia + YCA 执行。
- 只在当前 worktree 实现；未 push、创建 PR、merge、部署或改动默认分支工作区。

### 实际模块与关键接口

- `tools/codex-session-bridge/ui/`：strict TypeScript React 前端；迁入已确认 prototype 的石墨/淡紫 tokens、三栏、折叠 rail、窄屏 drawer、焦点管理、motion/reduced-motion 和 Split/Unified Diff 样式。数据全部来自真实 API，未迁入 snapshot/sample.diff/demo 消息。
- `ui/App.tsx`、`Conversation.tsx`、`Workbench.tsx`、`DiffViewer.tsx` 分别负责导航与页面、分页阅读、辅助事实和按文件 patch。`renderers.tsx` 按语义 kind 使用编译期 renderer registry；`conversation-state.ts` 按 item id + pixel offset 恢复 prepend 锚点。Composer 使用只读 capability 槽位，没有发送控件。
- `src/harness/presentation-model.ts`：共享 `Participant` / `SourceRef` / `ConversationItem` / 页面 DTO / `ComposerCapability` / `PatchDto`，不依赖 Node 或 provider runtime。`presentation.ts` 单独解释当前持久化 Codex 格式，其他层不解析 provider payload；unknown 保留再次 `protectedCopy` 的已持久记录、完整性和游标。
- `ConversationHistory.page(conversationId, { before?, after?, limit? })` 同时选择主/子历史；默认最新 50、最大 100、exclusive cursor、升序、first/last/high-water 与 has_older/has_newer。既有 domain detail 的显式数字 after 调用保持可用。
- `ChangesSource.fileIdentity` 的 revision 绑定 Ticket、repository instance、baseline、HEAD、路径/旧路径/kind、内容身份和文件元数据。`Changes.patch` 读取当前列表校验引用，并在收集 patch 后再次校验，变化返回 stale。
- `ChangesSource.patch` 对 tracked/rename 使用 literal pathspec、禁用 external diff/textconv 的 Git patch；untracked 生成标准 `/dev/null` patch。前后文本内容各限 64 KiB、完整 patch 限 128 KiB；不返回部分 patch 伪装完整。protected rename 的旧路径也参与保护，不泄露预览；binary/deleted/protected/too-large/truncated/stale/unavailable 均明确返回。
- `server.ts` 仅组合 listener/session/security，`routes.ts` 负责 API，`static-assets.ts` 负责原始 request-target 校验、manifest allowlist 和 containment/link 检查。普通 GET 不扫描；后台 collector 与显式 refresh 保留。已有 run/task stop 与 worktree open 控制继续保留。
- 新增 `GET /api/session` 和 `/api/ui/projects`、`/api/ui/tickets/:uuid`、`/api/ui/conversations/:uuid`；保留 `/api/projects` 等既有事实 API。将 presentation API 放在 `/api/ui/`，避免改变既有事实响应字段或让 frontend 消费 raw payload。
- Patch 路由：`GET /api/tickets/:ticketId/changes/files/:fileId/patch?revision=...`；stale→409、unavailable→503、invalid→400、Ticket missing→404。API/index/patch no-store，manifest hashed assets immutable；SPA fallback 仅三个已约定路径。
- 精确依赖：React/React DOM 19.3.0、Vite 8.3.0、plugin-react 6.1.1、react-diff-view 3.3.3、lucide-react 1.47.0、Radix dialog 1.1.23/collapsible 1.1.20/tabs 1.1.21；前端 runtime/build 版本取自 prototype lock。既有依赖版本保持不变。
- `tools/control-center/src/deployment.js`：ci 后显式 build:ui；manifest 增加整个 `dist/harness-ui` 产物树的 `uiHash`。read/verify 拒绝缺失 hash、文件变更/缺失/新增、links；已发布 release 不重建。`npm test` 增加 pretest build，直接 node --test 前需先 build:ui。

### 实现期低层调整

- 保留 prototype 的 Radix Dialog 焦点隔离、Esc、焦点恢复和动效；遮罩改为随构建发布的 CSS 元素。原因：Radix Overlay 的 scroll-lock 会动态插入 style tag，与严格 `style-src 'self'` 冲突。整个应用已有独立滚动容器，无需放宽 CSP。
- 既有 HTML 字符串断言迁为 presentation DTO/API 断言。之前依赖 GET 隐式扫描的测试改为显式驱动 collector；没有把扫描放回 GET。
- Owned task 的真实 id 为 epoch + `:` + UUID；request-target 校验只在既有 task stop 路径允许对应 `%3A`，继续拒绝 encoded slash/dot/double encoding。

### 定向验证

环境：Windows / PowerShell 7 / Node 24；package-local npm dependencies。以下命令均从对应 package 目录执行，不启动模型、真实部署或浏览器 Acceptance。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 最终 exit 0；后端与相关 TS 测试通过。 |
| `npm run typecheck:ui` | 最终 exit 0；strict 前端类型通过。 |
| `npm run build:ui` | 最终 exit 0；生产 manifest/index/hashed JS+CSS 已生成。 |
| `node --test test/harness-presentation.test.ts test/harness-ui-server.test.ts test/harness-patch.test.ts test/harness-conversations.test.ts test/harness-controls.test.ts test/harness-changes.test.ts` | exit 0，32/32。覆盖 known/unknown、分页、patch、static/security、GET-vs-refresh、旧控制/关联/Changes。 |
| `node --test test/harness.test.ts test/harness-computer.test.ts test/harness-tasks.test.ts test/harness-workflow.test.ts` | 首轮 32/35；3 个 task 测试依赖 GET 扫描，已改为独立 collector 驱动并定向复测通过。其余 24 个非 task 用例全部通过。 |
| `node --test test/harness-presentation.test.ts test/harness-ui-server.test.ts test/harness-patch.test.ts test/harness-tasks.test.ts` | 最终 exit 0，17/17；包含上述全部 11 个 task 用例、最终 protected rename 与 production build HTTP 校验。 |
| Control Center：`node --test --test-name-pattern='UI production artifacts\|failed UI build\|prepare follows remote\|dependency failure' test/deployment.test.js` | exit 0，4/4；UI tree hash 篡改/缺失/新增、build 顺序与失败不选中、release 复用。 |
| `git diff --check` | exit 0。 |

共 71 个不同定向用例最终通过，包含重复复测，未运行 repository full suite。最终 17 项原始输出保存在 worktree `.local/harness-012-verification/targeted-final.log`。

开发期红灯：Git 对相同内容可选择另一条合法 rename，fixture 改为不同内容后通过；测试文件新增的 headers 联合类型与 NodeNext type import 扩展名已修正，最终两项 typecheck 通过。未发现需扩展范围处理的 baseline unrelated failure。

### 未完成、风险与交接入口

- Primary Review：pending，未给出自审结论；外层应从 fixed point 审查整个本票 commit（含 planning delta 与新增文件），不复用 implementation 聊天。
- 完整测试套件：pending，由外层 YCA 执行。生产 browser Acceptance：pending；必须核对三栏/窄屏 drawer、真实 Main/Review/Focused Review、上翻锚点、文件切换与长行 Split、Unknown Advanced、只读 Composer、controls 及 CSP/network/console。HTTP 与测试通过不表示浏览器已验收。
- 浏览器重点：CSP 下的 Dialog/Collapsible 动效与焦点行为、真实长消息和长 diff 的可读性。当前实现无新 Provider、发送/续跑、WebSocket/SSE、插件 runtime、数据库或第二前端 server。
- 旧发布 manifest 缺少 `uiHash` 会被拒绝；这是本票要求的 artifact verification 门禁，不会自动改写旧 release。
- 本地提交主题：`feat: 产品化 Harness Conversation 工作台`。提交后的精确 SHA、工作树状态、产物 hash 与模型 usage 定位见 worktree `.local/harness-012-verification/implementation-state.json`；此文件由提交后写入，避免 handoff 自引用 SHA。
- 本 run 模型策略由调用方指定 `gpt-6-astra / high`；durable input/cached/output usage 在本 session 不可取得，记 unknown，交由外层 YCA 更新 checkpoint。

### 外层完整套件验证

- YCA / `tools/codex-session-bridge`：`npm test` 最终 **182 tests / 181 pass / 0 fail / 1 skip**。首次 full suite 暴露 2 个旧 shutdown 测试假设（server-rendered HTML 与 GET 隐式 scan）；fresh Astra low 仅更新测试语义，生产代码未改，commit `f7e8fbc49acb761f7fced579c024c310c4514f47`。
- Control Center：新增 UI build 后，真实 deployment 用例单独需要约 109～116 秒，旧 90 秒测试预算不再成立；调整测试 timeout 为 180 秒。
- Control Center full suite 还暴露：真实 deployment 后立即执行 executable refresh 时，Windows 主机短时负载可让 production 4 秒 executable probe 返回 `ETIMEDOUT`，而该用例独立运行通过。未放宽 production discovery 策略；测试套件改为 `--test-concurrency=1`，且 executable-refresh 只对明确的 `CODEX_EXECUTABLE_UNAVAILABLE + ETIMEDOUT` 在副作用发生前做 20 秒有界重试，其他错误立即失败。
- Control Center 最终 `npm test`：**51 / 51 pass，0 fail**；真实 deployment 验收约 116 秒，executable-refresh 在串行+有界重试下约 14 秒完成。
- 上述稳定化均为测试/测试运行策略调整；HARNESS-012 production 代码未因 full-suite 红项回退到 GET 隐式扫描，也未扩大 Codex executable discovery 的生产超时。

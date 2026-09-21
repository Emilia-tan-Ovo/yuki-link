# HARNESS-014 Implementation Notes

Source Ticket: GitHub #81

Parent Spec: GitHub #39 / `docs/specs/yuki-harness-v0.md`

Fixed point: `d3b68f2f700669b366f5bc8a768638918718d9c8`

## Investigation Findings

- HARNESS-013 的 grouping 是刻意收窄的执行白名单：只有带 `execution` metadata 的 `tool` / `task` / `lifecycle`，且类别为 command、tool、observation、output 才进入 `groupConversation`；`workflow`、`control`、unknown 和没有该 metadata 的 lifecycle 会直接成为边界。
- `source.snapshot` 已投影为 observation，但只有相邻记录同时满足同 source/scope/participant/category、无 issues、时间可信且间隔不超过 5 分钟时才合并；任何插入记录、scope 变化、时间上限或异常都会留下 singleton。当前算法又把 singleton 也渲染成 execution group，因此出现大量 `×1`。
- `recovery.observed` 明确没有 `execution` metadata；受管任务只有 output / observation 有 metadata，`stop.requested`、`stop.result` 等 lifecycle 没有；`control_action` 也是无 metadata 的 `control`。这些记录因此既不能合并，又走始终展开的 Event renderer。这是 HARNESS-013 的既有边界，不是分页层丢失数据。

## Implementation Decisions

- 保留 Journal、原子 `ConversationItem`、cursor/PageInfo、分页 merge、source payload 与 relation 契约；只调整 projection 提供的 provider-neutral presentation metadata、纯 UI grouping 和 renderer。分组仍由已加载原子 items 派生，不持久化新实体。
- 将现有 execution-only metadata / grouping seam 泛化为 auxiliary presentation grouping。可信 grouping identity 至少包含 family、source、scope、participant、观察时间、状态/issues 与可选 operation identity；projection 负责从已知来源建立 identity，React 不读取 raw payload 猜语义。
  - run 状态观察使用既有 binding/session/run/thread scope；同 scope 的连续 observation 可跨越 5 分钟上限合并，时间仍须可解析且不倒退。
  - `recovery.observed` 仅与同来源、同 binding/run scope、同事件 family 的连续 recovery 记录合并。
  - 受管任务 lifecycle 使用 source/service epoch/binding/task identity 作为 scope；同一 task 的连续 lifecycle（包括 `stop.requested`、`stop.attempt`、`stop.result`、root exit、pipes closed、final）形成“受管任务事件”记录组，不能跨 task 或 epoch。
  - 已知 control/workflow/lifecycle 只在 projection 能给出可靠 family + scope 时合并；unknown 不猜测 scope，仅作为折叠 singleton。
- 自然语言 `message` 是当前唯一直接展开的主叙事类型；实际 Review / Focused Review / Acceptance Agent 的自然语言结论因此保持直接可读。其余 tool、system、status、recovery、task、control、workflow、lifecycle、unknown 全部默认折叠，不按标题或正文内容推断叙事类型。
- 连续合并必须同时满足同 family/source/scope/participant、cursor 顺序相邻、观察时间可信且不倒退。message、session/thread 切换、Ticket/child Conversation 关联等身份边界、不同 task/run/epoch、明确 failure/diagnostic/issues、采集失败、归属冲突和无法建立可信 scope/顺序的记录继续断组；边界记录自身仍以折叠 singleton 展示。redacted/truncated/incomplete 标记本身不强制断组（沿用 running task output 先例），但必须聚合到关闭摘要并在展开的每条原子记录上保留。
- singleton 使用统一的辅助记录 disclosure，不显示乘数。只有安全组的展示计数大于 1 时才显示 `×N`；同一 operation 的 started/result 去重后若调用数为 1，也不显示 `×1`，同时注明原子记录数。组摘要显示实际时间范围、状态变化（不把 `completed` 改写为成功）、issues 和聚合 integrity。
- 展开组后按 cursor 顺序显示每条原子记录；每条仍可独立展开正文/tool output/integrity/source refs/Advanced Raw Evidence。分组不得删除、重排或合成原始事实，也不得用最后状态覆盖中间状态或来源缺口。
- 沿用 HARNESS-013 的跨页重新派生、稳定 member identity、open membership 与 scroll anchor seam；分页前后出现新相邻成员时允许重新组装，但 Review/Focused relation、Changes/Diff 和 Conversation 路由不参与 grouping。
- 删除 `Conversation` 底部整个 `.composer-slot` 占位区，并收掉 `composer` prop 传递及只为该区域使用的 import/CSS。顶部“只读”状态和现有 session capability/API 契约保留，避免把本票扩大为 Composer 或权限语义改造。
- 实现顺序：projection/grouping metadata → pure grouping 与 singleton shape → 非 message 统一 disclosure renderer → Conversation prop/占位区清理 → 定向测试、typecheck/build → 外层 Emilia 的真实 production-browser Acceptance。

## Test Seams

- `tools/codex-session-bridge/test/harness-presentation.test.ts`：使用真实 record shape 验证 `source.snapshot`、`recovery.observed`、owned-task lifecycle（至少 stop.requested/result）及 control 的 family/scope；不同 run/task/epoch 与 gap/failure 不共享 identity。
- `tools/codex-session-bridge/test/harness-conversation-reading.test.ts`：验证连续同 identity 聚合、跨长时间但时间单调的 observation、message/身份/异常/不可信 scope 断组、integrity 聚合保留、singleton 无 `×1`、operation 去重、状态变化摘要，以及 prepend/append 后 group key/open state/atomic anchor 不回归。
- `tools/codex-session-bridge/test/harness-conversation-rendering.test.js`：SSR 验证 message 正文直接出现；每一种非 message singleton 默认不暴露正文/raw；聚合组关闭时不含原子内容，展开后原子顺序、完整性提示和 Advanced 均可访问；Conversation 不再渲染“只读 Conversation”占位区。
- 保留 production UI build/typecheck；真实浏览器用 HARNESS-013 历史验证 desktop 默认折叠、observation/recovery/task lifecycle 的 `×N`、组/原子/Advanced 展开、分页与 scroll anchor，并复核 Review/Focused、Changes/Diff、顶部只读状态及 console/network/CSP。

## Deferred

- 淡入动画、工程 Agent 显示名、Acceptance 文案、App 图标/favicon 均不进入本票。
- 低风险字段名、中文短标签和 CSS 清理由实现按现有约定决定；不得修改 Journal schema、collector 行为、控制语义、分页 API 或建立新的服务端聚合实体。

### Context Plan

- Core: GitHub #81、本 Notes、`AGENTS.md`、`tools/codex-session-bridge/src/harness/presentation-model.ts`、`tools/codex-session-bridge/src/harness/presentation.ts`、`tools/codex-session-bridge/ui/conversation-reading.ts`、`tools/codex-session-bridge/ui/Conversation.tsx`、`tools/codex-session-bridge/ui/renderers.tsx`、上述三个定向测试文件。
- Related: `docs/specs/yuki-harness-v0.md` 的可追溯/折叠/恢复/停止语义；`docs/implementation-notes/HARNESS-013.md` 的原子证据、分页 anchor 与 relation 先例；`tools/codex-session-bridge/src/harness/task-model.ts`、`task-collector.ts` 的 task identity/lifecycle 事实。
- Retrieval: 需要核对来源形状时搜索 `source.snapshot`、`recovery.observed`、`control_action`、`owned_task`、`stop.requested`、`stop.result`、`execution`、`composer-slot`；只读相应 mapper/schema/fixture 片段。
- Expansion triggers: 只有 projection 无法从现有字段建立可靠 run/task/recovery scope，或泛化 grouping 会改变 Journal/分页/控制事实时，才暂停并扩大调查；否则不新增 Owner 问题。

## Implementation Handoff

- 来源：GitHub #81、Parent Spec #39 与本 Notes。implementation 从指定入口和 fixed point 恢复，没有读取或复述 ticket-design 聊天。
- 身份：worktree `C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-014`；branch `codex/harness-014-conversation-density`；启动 HEAD / fixed point 均为 `d3b68f2f700669b366f5bc8a768638918718d9c8`。启动时仅本 Notes 为 untracked，已保留并纳入本票提交。
- 实现范围：
  - `tools/codex-session-bridge/src/harness/presentation-model.ts`、`presentation.ts` 将 execution-only metadata 泛化为 provider-neutral auxiliary metadata；run observation、`recovery.observed`、owned-task output/observation/lifecycle 与 control 使用现有来源字段建立可信 family/source/scope/operation identity，Journal、原子记录、cursor/PageInfo 和来源证据不变。
  - `tools/codex-session-bridge/ui/conversation-reading.ts` 只从已加载原子 items 派生连续辅助记录组；同 family/source/scope/participant、cursor 单调且时间可信不倒退时合并。issues、身份变化、无可信 scope 和倒序/无效时间断组；integrity 聚合但不删除原子证据。调用 identity 去重，singleton 不显示 `×1`，状态变化保留在摘要中；跨页 stable key/open membership/anchor seam 沿用。
  - `tools/codex-session-bridge/ui/renderers.tsx`、`Conversation.tsx`、`App.tsx`、`product.css` 让 message 正文继续直接显示，其余种类统一默认折叠；组展开后按原顺序提供逐条 disclosure、正文/tool output、integrity、source refs 与 Advanced raw evidence。删除底部 `.composer-slot` 及 prop/CSS，顶部只读状态和 session composer capability 契约保留。
  - 三个定向测试文件覆盖真实 projection shape、长间隔/断组/去重/状态/integrity、跨页 key/open/anchor、SSR 默认折叠与 message 直读、原子 disclosure，以及 composer-slot 移除。
- TDD 与验证（cwd `tools/codex-session-bridge`）：首轮新 seam 对旧实现按预期为红；完成最小实现后最终 `node --test test/harness-conversation-reading.test.ts test/harness-presentation.test.ts test/harness-conversation-rendering.test.js` 为 17/17、exit 0；`npm run typecheck`、`npm run typecheck:ui`、`npm run build:ui` 均 exit 0；仓库根 `git diff --check` exit 0。实现过程中发现 worktree 的 `node_modules` junction 目标依赖不完整，已按现有 lockfile 在本 worktree 执行 `npm ci`，未改 lockfile 或全局环境。
- 未运行项：遵照票据范围未运行 full suite；未执行真实 production-browser Acceptance。SSR、纯分组与模拟 anchor 测试不替代真实浏览器对 HARNESS-013 历史、分页滚动、Review/Focused、Changes/Diff、顶部只读状态及 console/network/CSP 的验收。
- Review policy：delegated，接收方为外层 Emilia。primary Review **pending**；本 implementation session 未调用 reviewer，也不提供 Review finding 或通过结论。
- Finding/risks：当前没有来自 Review 的 finding；production-browser 行为仍是待核事实。没有修改 Journal schema、collector、控制语义、分页 API，也未加入淡入动画、工程 Agent 显示名、Acceptance 文案或 App 图标/favicon。
- Commit：提交主题 `feat: 收缩并聚合 Conversation 辅助记录`；精确 SHA、最终文件清单和验证摘要写入非 Git checkpoint `.local/workflow-state/HARNESS-014.md`。
- 下一步：外层 Emilia 以 fixed point → checkpoint commit 的完整本票 diff 启动 fresh primary Review，再执行 full suite 与真实 production-browser Acceptance。未 push、建 PR、merge 或 deploy。
- 模型成本：本 implementation session 的 durable usage 在当前上下文不可取得，input/cached input/output 与 anomaly 记为 unknown，由外层 durable run status 补齐，不使用模型估算。

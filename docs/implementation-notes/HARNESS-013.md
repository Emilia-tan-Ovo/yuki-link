# HARNESS-013 Implementation Notes

Source Ticket: GitHub #79

Parent Spec: GitHub #39

Fixed point: `583c809f2a8a21c950b7cbdaff89758ce669725c`

## Implementation Decisions

- 保留原子 `ConversationItem` 与 cursor 分页契约。当前 `projectRecord` 继续负责 provider/source payload → provider-neutral item 的解释，并为可识别执行记录补充中立的执行类别、范围、调用身份和状态；新增独立纯 presentation grouping module，在原子 items merge 后生成阅读用 `item | execution-group`。React 不读取 provider raw payload，不新增 Journal 实体。
- 仅连续、同类别、同 participant/source/execution scope 的已识别 tool/command、状态观察或同 task 输出可合组。message、workflow/Review/Acceptance、control、运行/上下文边界、`recovery.observed`、unknown 与明确失败/异常断组；相邻记录观察时间间隔超过 5 分钟或时间不可信时断组。
- 调用计数按可信 operation identity 去重；`started/result` 不重复计数。缺少可信调用身份时显示“执行记录 × N”，不冒称 N 次调用。摘要仅覆盖当前已加载成员，保留类别、数量、最后状态、明确异常、时间范围与 integrity；`completed` 不自动推断成功。
- command、stdout/stderr/combined output、逐项记录与 Advanced Raw Evidence 默认折叠；展开后按原始顺序保留完整成员证据。自然语言 message 和重要 workflow/review/acceptance 结论保持主叙事位置。
- grouping 不改变原始 ID、cursor、PageInfo；跨页重新派生 group 时保留稳定 group/member identity。prepend anchor 若成员被折入 group，恢复到包含该成员的 group；展开状态不因跨页合组而无故重置。
- Tabs 改为单行不收缩、局部横向滚动；使用紧凑且可区分的显示名（例如 Main / Review 1 / Focused 1 / Focused 2 / Acceptance）。路由与选中仍以 conversation ID 为准。`ConversationLink` 补齐必要的 `review_id` / participant 等 relation 字段，完整 participant/review/isolation/original review/finding refs 通过 accessible label / relation strip 查看，不从长 label 反解析身份。
- Header 常驻只保留 Ticket key、紧凑标题和阶段/accepted；去掉“工程协作历史”等装饰性占高，baseline/current HEAD 与详细 Workflow/Review/Changes 继续放在 Workbench。Workbench 不默认隐藏，只通过层级/对比度/间距退居辅助位。
- 桌面 Ticket heading + tabs 以约 100–112px 作为初始调试目标；最终用相同 viewport、相同 Ticket 的浏览器前后测量确认有效高度改善。正文维持约 15–16px、1.75–1.85 行高，优先减少重复元信息和执行行间距。
- 定向测试覆盖：grouping 白名单/断组/计数/异常、跨页合组与 anchor、relation identity、默认折叠与展开证据。真实 production-browser Acceptance 验证 desktop/narrow tabs、header/Conversation 有效高度、Execution Group 展开/收起、Review/Focused Review、drawers、read-only Composer、Diff 与无 blocking console/network/CSP error。
- 实现顺序：projection execution metadata + pure grouping → Conversation renderer/anchor/open state → tabs/header/Workbench polish → 定向验证 → Emilia production-browser Acceptance。
- Deferred：字段命名、短标签格式、CSS 最终数值按现有约定和浏览器测量确定；不得扩大到 archive 自动导入、Live/Archived、Spec/任务分组、真 Composer、DeepSeek adapter 或 tunnel 整合。

### Context Plan

- Core:
  - GitHub #79 + 本 Notes
  - `AGENTS.md`
  - `tools/codex-session-bridge/src/harness/presentation-model.ts`
  - `tools/codex-session-bridge/src/harness/presentation.ts`
  - `tools/codex-session-bridge/ui/App.tsx`
  - `tools/codex-session-bridge/ui/Conversation.tsx`
  - `tools/codex-session-bridge/ui/conversation-state.ts`
  - `tools/codex-session-bridge/ui/renderers.tsx`
  - `tools/codex-session-bridge/ui/common.tsx`
  - `tools/codex-session-bridge/ui/Workbench.tsx`
  - `tools/codex-session-bridge/ui/styles.css`
  - `tools/codex-session-bridge/ui/product.css`
  - `tools/codex-session-bridge/test/harness-presentation.test.ts`
- Related:
  - `tools/codex-session-bridge/test/harness-ui-server.test.ts`
  - `tools/codex-session-bridge/test/harness-conversations.test.ts`
  - `tools/codex-session-bridge/test/harness-workflow.test.ts`
  - `tools/codex-session-bridge/src/harness/model.ts`
  - `tools/codex-session-bridge/src/harness/task-model.ts`
  - `docs/design/yuki-harness-v0-handoff.md` Conversation 模型片段
- Retrieval:
  - 按需搜索 `call_id`, `item.id`, `source.snapshot`, `recovery.observed`, task binding, `original_review_id`, `finding_refs`。
  - 工具类别/operation identity 不明确时只查对应 collector 与最小 fixture；不读完整历史，不解析 command 猜测 provider 执行语义。
- Expansion triggers:
  - 只有当实现必须修改 Journal/分页契约、无法保持 anchor/证据、或 relation 与既有 Workflow 事实冲突时，才暂停并扩大调查。
- Fresh implementation preflight:
  - 核对 worktree HEAD/fixed point、依赖、Node/构建工具、浏览器验收入口；宿主无 `rg`，使用 Git/PowerShell。

## Implementation Handoff

- 来源：GitHub #79（Parent Spec #39）与本 Notes。implementation 从当前 Ticket/Notes/代码恢复，没有使用设计聊天或历史 Review/Acceptance。
- 身份：worktree `C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-013`；branch `codex/harness-013-conversation-ux-polish`；启动 HEAD / fixed point 均为 `583c809f2a8a21c950b7cbdaff89758ce669725c`。启动时只有本 Notes 为 untracked，已保留并纳入提交。
- 实现文件与 seam（以下路径均相对仓库根）：
  - `tools/codex-session-bridge/src/harness/presentation-model.ts`、`tools/codex-session-bridge/src/harness/presentation.ts`：增加可选 execution metadata 与显式 review/participant relation；来源语义仍由 `projectRecord` 解释，Journal/cursor/PageInfo 不变。
  - `tools/codex-session-bridge/ui/conversation-reading.ts`：纯分组、摘要、可信调用去重、前次成员重叠的稳定 key、成员展开集合、短 tab 标签与完整 accessible relation。输入为 merge 后原子 items；metadata 来自当前投影，每次 prepend/append 重新派生，不持久化分组。
  - `tools/codex-session-bridge/ui/Conversation.tsx`、`tools/codex-session-bridge/ui/conversation-state.ts`：跨页重新分组，保留 member identity；非跟随底部时捕获 anchor，可恢复到包含原成员的 group。
  - `tools/codex-session-bridge/ui/renderers.tsx`、`tools/codex-session-bridge/ui/common.tsx`：Radix 实际折叠，执行组、逐项记录、tool 内容与 Advanced 默认关闭；成员 disclosure 状态保存在 Conversation，避免重新合组或折叠父层后丢失。摘要保留失败/诊断、最后状态、时间和 integrity。
  - `tools/codex-session-bridge/ui/App.tsx`、`tools/codex-session-bridge/ui/Workbench.tsx`、`tools/codex-session-bridge/ui/product.css`：紧凑 header、可横滚不收缩 tabs、完整 relation 可访问名/详情、降低 Workbench 视觉权重。read-only Composer、drawers、Changes/Diff 沿用既有功能。
  - `tools/codex-session-bridge/test/harness-conversation-reading.test.ts`、`tools/codex-session-bridge/test/harness-conversation-rendering.test.js`、`tools/codex-session-bridge/test/harness-presentation.test.ts`：分组边界/计数/异常、跨页 key/open/anchor、重复 Focused relation、投影、折叠标记与主叙事验证。
- 定向验证（cwd `tools/codex-session-bridge`，均最终 exit 0）：
  - `node --test test/harness-conversation-reading.test.ts test/harness-presentation.test.ts`：10/10 通过。
  - `node --test test/harness-conversation-rendering.test.js`：1/1 通过；用现有 Vite SSR 加载实际 renderer，验证 closed 不含 command/output/raw 内容，open group 含逐项 disclosure、异常/完整性摘要可见，message 正文可见。这不是浏览器交互验收。
  - `npm run typecheck`、`npm run typecheck:ui`、`npm run build:ui`：全部通过。首轮服务端 typecheck 指出 acceptance relation 无 participant，已按判别类型修复并复测。
  - `git diff --check`：通过。完整 `npm test` 未运行，交外层 YCA。
- Review policy：delegated，接收方为外层 Emilia。primary Review **pending**，由其 fresh reviewer session 执行；本 session 不给 Review finding/通过结论。
- 限制/待验收：代码实现与定向验证已完成；尚未进行真实 production-browser Acceptance。需同 viewport/同 Ticket 对比 header 与 Conversation 有效高度，验证 desktop/narrow tabs、多 Focused Review relation、分组/逐项/tool/Advanced 展开收起与分页锚点、键盘焦点、drawers、read-only Composer、Diff，以及 console/network/CSP 无 blocking error。SSR 与模拟 anchor 测试不替代这些检查。
- Commit：提交主题 `feat: 优化对话执行分组与阅读布局`；提交后的精确 SHA、文件清单及验证摘要保存在本 worktree 非 Git checkpoint `.local/harness-013/implementation-checkpoint.json`，避免将提交自身 SHA 循环写入提交。
- 下一步：外层 Emilia 以 fixed point → checkpoint commit 的本票完整 diff（含 Notes 与新增测试）启动 fresh primary Review，再执行完整套件和浏览器 Acceptance。未 push、建 PR、merge 或部署常驻 7391/7394；implementation handoff 后停止。
- 模型成本：本 session 获准 Astra medium；durable usage 当前不可取得，input/cached input/output 与 anomaly 均记 unknown，由外层 durable run status 补齐，不用模型估算。

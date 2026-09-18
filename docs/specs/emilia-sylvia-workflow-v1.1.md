# Emilia × Sylvia Workflow v1.1

GitHub Issue: [#22](https://github.com/Emilia-tan-Ovo/yuki-link/issues/22)

状态：设计决策与测试 seam 已确认；Spec 已形成，待拆票与逐票实现。

日期：2026-09-18。

依据：Workflow v1.1 已确认决策、现有 matt Skills 行为、YCA-001～007 的真实协作数据、resident YCA 运行记录，以及桓宇确认的测试 seam。

## Problem Statement

当前 Emilia × Sylvia 协作已经具备从需求设计、Spec、Tickets、实现、测试、Review 到 resident acceptance 的主要能力，但真实使用中仍存在以下系统性问题：

- 桓宇仍可能被拉回承担流程管理或跨 Agent 传话；
- implementation 与 review 可能共享过多隐式上下文，削弱独立判断；
- 所有改动默认进入完整双轴 Review，使局部修复、文档和 closeout 承担不必要成本；
- finding 修复后可能重复整套 Review；
- 当前执行状态仍可能依赖模型上下文，fresh session 难以可靠恢复；
- 模型自述与文件、Git、命令、MCP/YCA 事件等 ground truth 之间缺少统一门禁；
- 大型日志、Git history 和 runtime JSONL 直接交给模型全量扫描时会造成超时、噪声和上下文膨胀；
- Issue 完成后的关键过程证据分散在 GitHub、YCA runtime 与本机目录中，长期复盘成本高；
- Emilia 等待 Codex run 时存在重复 status/output 轮询；
- ChatGPT/客户端/网络等外部平台可能在任意阶段中断当前对话，恢复仍需要依赖显式 checkpoint，而不能假设模型上下文连续；
- 当前多个 Skills 已能独立工作，但缺少一层统一的工作流编排来管理阶段、session、checkpoint、review 路由、acceptance 和 closeout。

Workflow v1.1 需要在不推翻现有 matt Skills 主流程的前提下，把这些能力组织成可恢复、可验证、可分级、可长期追溯的三人协作工作流。

## Solution

保留主流程：

```text
pair-with-docs
→ to-spec
→ to-tickets
→ ticket-design
→ implement
→ review
→ acceptance
→ closeout
```

新增 `engineering-workflow` 作为上层 workflow/router。它负责识别当前阶段、调用已有领域 Skills、维护 workflow checkpoint、管理 session 生命周期、选择 Review 路径、组织 resident acceptance 与 closeout；它不替代各领域 Skill 的内部职责。

新增 `review-change` 作为 Review Router：

- `full`：完整 Standards + Spec 双轴 Review；
- `focused`：只围绕具体风险或原 finding 的局部 Review；
- `evidence`：用于 docs-only、acceptance 记录和 closeout 的证据一致性检查。

Review 遵守 upgrade-only 原则：可以因为真实 diff、证据冲突或新风险升级，不能为了节省成本降级明显高风险的改动。

工作流在阶段边界把恢复所需状态写入外部 checkpoint，使 fresh session 可以在不依赖隐藏聊天上下文的情况下恢复。模型上下文作为缓存，而不是唯一状态存储。

implementation session 默认可以承接 ticket-design 的有价值局部上下文；review session 默认 fresh；focused re-review 默认 fresh；acceptance 默认 fresh 或由 Emilia 从外部事实直接验收。只有 continuity 本身属于验收目标时才刻意复用 session/thread。

每张票完成后生成轻量 closeout archive 进入版本控制；原始 JSONL、大型 runtime 日志继续留在本机 YCA runtime / .local，不提交 Git。

Workflow v1.1 同时纳入两个工程增强方向：

- 减少等待 Codex run 时的重复状态/输出轮询，并提供围绕“新事件、run 终态、等待窗口”表达的等待能力；
- 自动生成一致的 closeout archive。

这两个方向的具体 API、参数与最终实现形态留给后续 ticket-design，不在本 Spec 固定。

## User Stories

1. 作为 Owner，桓宇希望只参与产品目标、用户可见行为、重大架构、安全、数据语义和不可逆决策，从而不再承担日常流程管理。
2. 作为 Owner，桓宇希望 Emilia 与 Sylvia 能直接交换必要事实和工作产物，从而不需要人工转述。
3. 作为 Orchestrator，Emilia 希望通过统一工作流入口识别当前阶段并调用正确的领域 Skill。
4. 作为 Orchestrator，Emilia 希望设计、Spec、Tickets、implementation、Review、acceptance 和 closeout 之间存在明确阶段边界。
5. 作为 Repository Engineer，Sylvia 希望 ticket-design 与 implementation 默认可以复用连续上下文，以保留刚建立的代码 seam、测试位置和 precedent。
6. 作为 Reviewer，Sylvia 希望 Review 默认运行在独立 fresh session 中，只接收 fixed point、diff、Spec/Ticket、工程标准和必要测试证据。
7. 作为修复者，Sylvia 希望 finding 修复后只围绕原 finding、修后 diff 和相关规范执行 focused re-review。
8. 作为 Orchestrator，Emilia 希望根据实际 diff 和风险选择 full、focused 或 evidence Review，并能在发现更高风险时升级。
9. 作为质量门禁，Emilia 希望权限、安全、并发、持久化、数据/schema、迁移、外部契约、架构边界和广泛生产代码变更进入完整双轴 Review。
10. 作为质量门禁，Emilia 希望局部 bug fix、已知 finding 修复和小范围明确行为变化可以进入 focused Review。
11. 作为质量门禁，Emilia 希望 docs-only、验收记录、closeout 和不改变生产行为的元数据更新通过 evidence Review，并在发现风险时升级。
12. 作为 fresh session，Agent 希望能通过外部 checkpoint 恢复当前 ticket，而不依赖上一段模型上下文。
13. 作为 fresh session，Agent 希望 checkpoint 明确当前 phase、Git 身份、关键 session/run、已确认决定、当前证据、未关闭 finding 和 next action。
14. 作为 fresh session，Agent 希望恢复时重新验证 checkpoint 中易变化的 Git、YCA、测试和 runtime 状态。
15. 作为 Orchestrator，Emilia 希望 checkpoint 只在阶段边界或恢复路径发生变化时更新，而不是变成逐命令日志。
16. 作为验收者，Emilia 希望通过文件、Git diff、命令退出码、测试结果、YCA/MCP 事件和 run 状态核对真实结果，而不是依赖模型成功声明。
17. 作为语义 Reviewer，Sylvia 希望专注判断实现是否符合 Spec、是否符合工程标准以及是否发生 scope creep。
18. 作为长任务编排者，Emilia 希望根据任务是否持续产生新证据和有效推进来决定是否等待，而不是依赖统一硬超时。
19. 作为大型证据分析者，Agent 希望先通过确定性工具把大型日志、Git history、测试输出和 runtime 数据压缩成结构化结果，再做语义分析。
20. 作为项目维护者，桓宇希望每张票完成后留下轻量、可版本化的 closeout 摘要，以便 fresh clone、新设备或 fresh Agent 能理解历史过程。
21. 作为项目维护者，桓宇希望 closeout 摘要能指向原始本机证据，但不把完整 runtime 日志提交 Git。
22. 作为单独调用 `implement` 的用户，桓宇希望原有行为继续默认进入完整 `code-review`，保持向后兼容。
23. 作为通过 `engineering-workflow` 调用 `implement` 的编排者，Emilia 希望实现完成后取得结构化 handoff，并将 Review 选择交给 `review-change`。
24. 作为 Codex run 调用方，Emilia 希望等待能力可以在“有新事件”“run 到达终态”或“等待窗口结束”时返回，从而减少重复轮询。
25. 作为 closeout 执行者，Emilia 希望自动生成一致的 archive 摘要，同时保留人工核对和追溯能力。
26. 作为 Agent，Sylvia 希望在当前票没有真正高杠杆实现决策时，ticket-design 可以直接形成 Implementation Notes，而不是制造问题要求桓宇选择。
27. 作为项目参与者，三方希望能力说明继续区分“代码已实现”“真实链路已验收”“日常场景稳定使用”，避免把一次通过扩大成长期稳定结论。
28. 作为 Orchestrator，Emilia 希望 ChatGPT 审查、客户端断连、网络中断或对话切换后，可以仅凭 checkpoint 和外部事实恢复正确 phase / next action，而不重复已完成阶段或副作用。

## Implementation Decisions

- 保留现有主流程及现有 Skills 的单一职责。
- 新增 `engineering-workflow` 作为上层编排 Skill，负责阶段识别、Skill 路由、checkpoint、session 生命周期、Review 路由、acceptance 和 closeout。
- 新增 `review-change`，提供 `full`、`focused`、`evidence` 三条路径。
- `full` 调用现有 `code-review`，继续保留 Standards 与 Spec 两个独立审查轴。
- Review 路由遵守 upgrade-only 原则；明显高风险改动不得为了成本而降级。
- `focused` 只接收具体 finding/风险、相关 diff、fixed point 和必要规范，不重复整票 Review。
- `evidence` 负责 diff 基本有效性和证据一致性；发现生产行为变化、规范冲突或更高风险时升级。
- `pair-with-docs` 阶段结束时形成可恢复 Design Handoff；运行期 session/run 状态不进入领域文档。
- `to-spec` 保留“不重新采访用户”，优先使用已确认 handoff、CONTEXT/ADR 和代码事实综合正式 Spec。
- `to-tickets` 保留 tracer-bullet vertical slices 与真实 blocking edges；初始 risk hint 仅供后续 Review 路由参考。
- `ticket-design` 保留 implementation frontier；调查后 frontier 为空时可以直接形成 Implementation Notes，不强制制造用户问题。
- `implement` 保留 TDD、定向测试、typecheck、最终完整测试和 commit，并在完成后产生 Implementation Handoff，至少包含 fixed point、HEAD、变更范围、测试、已知风险和 commit。
- 若存在上层 workflow policy，`implement` 将后续 Review 交给 `review-change`；单独使用 `implement` 时继续默认调用完整 `code-review`。
- implementation session 默认可以延续 ticket-design session；上下文异常膨胀时允许通过 handoff + checkpoint 切换 fresh implementation session。
- review session 默认 fresh；implementation 历史不能作为 reviewer 的隐式证据。
- focused re-review 默认 fresh。
- acceptance 默认 fresh，或由 Emilia 直接使用 filesystem、Git、PowerShell、HTTP、YCA events、status/output 等外部事实完成。
- 只有 session/thread continuity 本身属于验收要求时才复用原 session。
- checkpoint 使用 YAML Front Matter + Markdown Body 的组合：机器字段结构化，人类语义内容可读。
- checkpoint 是恢复导航，不是动态事实最终 source of truth；恢复时必须重新验证 Git/YCA/runtime/test 等易变化事实。
- checkpoint 仅在阶段边界、finding 状态变化、acceptance 转换或影响恢复路径的异常时更新。
- 活跃 checkpoint 保持为 repo-local 非 Git 状态，不进入长期版本历史。
- closeout archive 进入版本控制，用于长期恢复；完整 JSONL、大型 runtime 日志不提交 Git。
- closeout archive 至少记录 Issue/Ticket、工作分支、关键 session/run、模型与 reasoning、代表性耗时/调用、失败/重试、Review findings、修复、PR/merge、人工介入点和原始证据位置。
- 大型日志、Git history、测试输出和 runtime JSONL 先经确定性筛选/压缩，再交给模型分析。
- 任务等待按照是否持续产生新证据和有效推进判断，不规定统一硬时长。
- **观察等待窗口与 Codex run 的执行终止策略必须解耦。** 观察端一次等待结束只表示“本次没有更多事件可返回”，不得因此停止仍在运行的 Codex run。
- Workflow 不得为了便于轮询而给正常 Agent 工作统一附加短的 wall-clock execution timeout。仍在持续产生有效进展的 run 不应仅因为固定观察时长到期而被终止；真正的 hard execution deadline 必须是明确、可观察的 run policy，而不是隐藏的等待副作用。
- Codex wait/long-poll 纳入 v1.1 首批交付目标：必须同时解决重复 status/output 轮询，以及观察等待与执行 timeout 混淆的问题；公共语义至少覆盖“新事件、run 终态、等待窗口结束”。具体工具名、参数、是否采用可续期/无默认 hard deadline 等实现细节留给 ticket-design。
- closeout archive automation 纳入 v1.1 首批交付目标：必须减少手工摘要重复劳动并保持可追溯；具体采用 Skill、仓库脚本或其他实现留给 ticket-design。
- external interruption 属于恢复路径的一部分：平台审查/断连本身不等同于项目失败；恢复先读 checkpoint，再验证 Git/YCA/runtime/tests，已完成且证据充分的阶段不重复执行。
- 不修改用户全局 Codex 配置作为 Workflow v1.1 的前置或副作用。
- 能力状态继续区分 implemented / accepted / stable。

## Testing Decisions

- **Primary acceptance seam**：fresh session 下的 `engineering-workflow` Skill 公共入口。
- 在临时 fixture 仓库中提供 Design Handoff、Spec/Ticket、Implementation Notes、Git 状态与可控 YCA/runtime 证据，覆盖 implementation、Review、finding 修复、acceptance 与 closeout。
- Primary seam 只观察公共行为：是否调用正确阶段 Skill、session 是否按规则隔离、checkpoint 是否在正确阶段更新、Review 路由是否符合风险、是否生成可恢复 handoff 和 closeout archive。
- 同一验收必须再启动一个全新 session，仅依赖持久化产物恢复任务；fresh session 必须重新验证易变化的动态状态，并从 checkpoint 的 next action 继续。
- fixture 至少覆盖：
  - implementation / review / acceptance 任一阶段的人为 external interruption，恢复后不重复已完成阶段或未知副作用；
  - ticket-design → implementation 连续上下文；
  - full Review 使用 fresh reviewer；
  - finding 修复后进入 fresh focused re-review；
  - docs-only / closeout 进入 evidence Review；
  - evidence/focused 发现更高风险后升级；
  - checkpoint 动态事实过期后被重新验证；
  - acceptance 使用 ground truth，而不是模型自述；
  - closeout 生成长期摘要且不复制大型原始日志；
  - 单独调用 `implement` 时仍默认完整 `code-review`。
- 测试外部行为和恢复能力，不断言提示词具体措辞、内部推理、固定 session ID、固定 run ID、内部函数名或 mock 调用次数。
- **Secondary seam 1**：如果 closeout automation 形成独立脚本/CLI，则以其公共输入/输出验证必要字段、可追溯性、错误处理、结果一致性和“不复制完整原始日志”。
- **Secondary seam 2**：Codex run lifecycle 以 YCA MCP 公共边界验证至少三种观察返回条件：出现新事件、run 到达终态、等待窗口结束；并验证观察等待窗口结束不会停止仍在运行且持续产生进展的 run，hard execution deadline 与 observation wait 是独立语义。
- 现有 Skills 行为作为兼容性先例：设计阶段不自动实现、to-spec 优先最高且最少 seam、ticket-design 只处理实现级高杠杆决定、implement 保持测试/commit 语义、code-review 保持 Standards/Spec 双轴分离。
- 单次 fixture 或真实链路验收通过只能证明该版本在该场景下通过，不构成长期稳定证明。

## Out of Scope

- 推翻或替换现有 matt Skills 主流程。
- 把所有领域 Skill 合并进 `engineering-workflow`。
- 改变 `code-review` 的 Standards / Spec 双轴语义。
- 为 Workflow v1.1 强行引入 HTTP、数据库等与交付形态无关的测试层。
- 读取模型剩余 token，或依赖模型准确报告上下文容量。
- 把完整聊天、模型思考、每条命令或完整 runtime 日志写入 checkpoint / Git。
- 为所有任务设置统一固定超时。
- 在 Spec 阶段固定 Codex wait/long-poll 的具体工具名、参数名、响应 schema 或传输实现。
- 在 Spec 阶段固定 closeout automation 必须采用 CLI、MCP 工具或某一种模块结构。
- 修改用户全局 Codex 配置。
- 解决 Control Center/Supervisor 登录自动恢复问题。
- 为非阻塞 Context7 warning 单独修改配置。
- 通过硬编码路径解决 Codex executable hash 变化。
- 解决 ChatGPT 客户端自定义插件 schema 刷新机制。
- 将一次验收结果表述为长期稳定运行证明。

## Further Notes

- 稳定工程规则属于项目级规范；领域语言属于 CONTEXT；难以逆转的设计属于 ADR；产品需求属于 Spec/Ticket；实现级决定属于 Implementation Notes；高动态执行状态属于 checkpoint；原始事实属于 Git/YCA/tests/runtime；完成后的长期摘要属于 closeout archive。
- 模型上下文只能作为缓存。阶段产物必须足够让 fresh session 恢复，不能依赖同一聊天持续存在。
- 桓宇保留产品、架构、安全、数据语义、范围扩大和不可逆操作的决定权；日常事实调查、流程推进和质量门禁由 Emilia / Sylvia 按职责完成。
- 任何工程增强都应在自己的 ticket 中完成实现级设计，不在本 Spec 偷偷固定尚未确认的 API。

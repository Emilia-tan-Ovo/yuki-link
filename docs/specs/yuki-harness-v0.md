# Yuki Harness V0

GitHub Issue: [#39](https://github.com/Emilia-tan-Ovo/yuki-link/issues/39)

状态：正式 Spec 已形成并发布；`to-tickets` 已完成，当前 frontier 为 HARNESS-001 / #40。

日期：2026-09-19。

## Problem Statement

桓宇已经与 ChatGPT 中的 Emilia、Codex 家族工程 Agent Sylvia 建立三人协作方式，并通过 YCA 与 Workflow v1.1 完成工程工作。但可观察过程分散在聊天、工具结果、Agent runtime、Git 和工作流产物中，缺少统一、持久、可回看的工程控制台。

ChatGPT 客户端断线、审核或界面异常会中断观察和指挥体验，桓宇难以判断任务是否仍在工作、哪些动作已经发生、当前卡在哪个阶段，以及如何安全接续。单看模型的完成声明、run 终态或当前工作树 diff，也不能回答 Review 是否通过、Acceptance 是否完成、整张 Ticket 最终改了什么。

V0 需要在保留现有 Emilia 的记忆与协作体验的前提下，提供独立于聊天界面的后台记录与日常管理能力。它减少观察缺口和恢复成本，不宣称消除 ChatGPT 平台本身的中断，也不以重做 Orchestrator、工程 Agent 或服务管理器为代价。

## Solution

交付可在 Windows 本地使用的 Yuki Harness 工程控制台。登录后后台 Runtime 自动启动，持续采集和持久化纳入观察边界的工程事件；UI 关闭不影响后台记录，重新打开后恢复观察并补齐已持久化的可用历史。

首页按 Project 分组展示 Tickets、运行与推进状态、finding、验收结果以及 recording、YCA、tunnel 等系统状态。在 Ticket 内，以长期 Conversation 为主工作面，常驻展示累计 Changes 和 Workflow 信息，并提供独立 Review 等子 Conversation 的关联入口。

V0 中实际 Orchestrator 仍是 ChatGPT 中的 Emilia。她显式登记任务归属、发起新工程意图并核验是否继续执行。Harness 负责观察、恢复连接、刷新、停止已有运行和日常服务管理；服务管理完全复用现有 Control Center / Supervisor。

可追溯性优先：记录失效时，系统拒绝新的有副作用工程动作，包括经 ChatGPT → YCA 外部入口发起的动作；只读观察可继续，已有任务不因记录故障被粗暴强杀。恢复后先核对真实事实和未知副作用，不自动重放工程工作。

## User Stories

1. 作为 Owner，桓宇希望登录 Windows 后后台自动开始工程观察与记录，从而不必记得先打开 UI。
2. 作为 Owner，桓宇希望关闭 UI 后后台继续记录，从而可以离开界面而不丢失期间已采集的过程。
3. 作为 Owner，桓宇希望重开 UI 后补齐后台已持久化的可用历史，从而接上之前的观察位置。
4. 作为 Owner，桓宇希望后台自启和自动重连不会发起模型请求或续跑工程任务，从而不会意外产生执行与费用。
5. 作为 Owner，桓宇希望首页按 Project 展示各 Ticket 的 phase、运行、finding 和 accepted 等状态，从而先掌握各项目整体推进情况。
6. 作为 Owner，桓宇希望异常和待处理 Ticket 在所属项目内突出显示，并能看到 recording、YCA、tunnel 等系统状态，从而判断阻塞来自任务还是基础服务。
7. 作为 Owner，桓宇希望进入 Ticket 后以 Conversation 为主要工作面，同时查看 Changes 与 Workflow，从而把过程、产物与阶段联系起来。
8. 作为 Owner，桓宇希望从 Ticket 访问 Review、Focused Re-review 和必要的 Acceptance Agent 子 Conversation，从而独立检查它们的结论与证据。
9. 作为 Orchestrator，Emilia 希望发起工程任务时显式登记 Project / Ticket，从而让协作记录具有可靠归属。
10. 作为 Orchestrator，Emilia 希望 cwd、Git 和 checkpoint 辅助填充与校验归属，冲突时明确提示而不自动改归属，从而避免记录串票。
11. 作为 Owner，桓宇希望一张 Ticket 的主 Conversation 跨 session 切换、fresh context 和 thread 重建保持同一身份，从而连续回看整票历史。
12. 作为工程 Agent，Sylvia 希望 ticket-design → implementation 的既有连续上下文语义保持，从而不因新增界面被迫重新建立工程上下文。
13. 作为 Reviewer，工程 Agent 希望 fresh Review 与 fresh focused re-review 保持上下文隔离，从而不因父子 Conversation 展示关系继承 implementation 历史。
14. 作为验收者，Emilia 希望直接通过外部事实完成 Acceptance 时只记录验收活动与证据，从而不会产生虚构的 Acceptance Agent 会话。
15. 作为 Owner，桓宇希望追踪实际收到的任务消息、Agent 回复、工具调用及结果、输出和退出状态，从而看到可观察的中间过程。
16. 作为 Owner，桓宇希望追踪 session / run 生命周期、可观察模型配置、错误、重试和停止过程，从而判断任务真实进展。
17. 作为 Owner，桓宇希望将 Workflow、checkpoint、Review mode / finding、Acceptance 和 closeout 与相关工程过程关联，从而核对阶段结论的依据。
18. 作为 Owner，桓宇希望折叠或摘要事件不丢弃已接收的底层记录，从而能够回看必要细节。
19. 作为 Owner，桓宇希望区分来源未提供、尚未收到、采集失败、保存失败、脱敏、截断和主动清理，从而不把证据缺失误认为没有发生。
20. 作为 Owner，桓宇希望可见模型陈述、Provider 暴露的 reasoning 与执行事实明确区分，从而不把推理文字当作文件、测试或验收证据。
21. 作为 Owner，桓宇希望工程历史默认长期保存在本机且不自动过期，从而在任务结束后仍可追溯；后续按 Project / Ticket 主动清理时仍能看到完整性提示。
22. 作为 Owner，桓宇希望记录失效时明确看到降级状态，从而知道系统暂时无法保证持久记录。
23. 作为 Owner，桓宇希望记录失败时新的有副作用工程动作被拒绝，且 ChatGPT → YCA 也不能绕过，从而落实可追溯性优先。
24. 作为 Orchestrator，Emilia 希望记录失败期间仍能只读核对状态，已有 run 不被粗暴强杀，从而尽量观察安全终态并识别证据缺口。
25. 作为 Orchestrator，Emilia 希望记录恢复后先核验 Git、YCA、runtime、checkpoint、finding、原授权与未知副作用，再决定继续执行，从而避免重复操作。
26. 作为 Owner，桓宇希望 Changes 默认回答整张 Ticket 从开始到当前累计改了什么，从而查看最终工程产物而非仅最后一次 run 的差异。
27. 作为 Owner，桓宇希望从累计 Changes 下钻到 run / commit 关联信息，从而定位具体执行与提交过程。
28. 作为 Owner，桓宇希望原有用户修改、并发编辑或证据缺口造成的归因不确定被明确标注，从而不会把所有 diff 误认成 Agent 贡献。
29. 作为 Owner，桓宇希望在 Harness 恢复观察、刷新状态、停止已有 run 和打开 worktree，从而完成日常任务管理。
30. 作为 Orchestrator，Emilia 希望新工程任务与真正续执行仍由自己发起，从而不与 Harness 形成两个独立指挥入口。
31. 作为 Owner，桓宇希望在 Harness 使用日常 YCA / tunnel / version / restart / update 入口，并保留 Control Center 的高级维护入口，从而统一日常体验且不产生两个服务管理者。
32. 作为 Owner，桓宇希望运行版本、健康、进程归属和任务状态具有来源及观察时效，从而不会把历史探测当作当前事实。
33. 作为项目维护者，希望 V0 复用现有 YCA、Codex bridge 与 Workflow，并保留未来替换 Brain / Engineering Agent 的边界，从而逐步迁移而不提前建设所有 Provider。

## Implementation Decisions

- **Yuki Harness 的新增与新建长期代码默认以 TypeScript 为主。** 现有 YCA / Control Center 的 JavaScript 继续受支持，不把一次性重写作为 V0 前置；只有在存在明确收益时才渐进迁移，并保持公开行为与现有契约兼容。TypeScript 与现有 JavaScript 必须可互操作；具体 `tsconfig`、运行 / 构建策略和工具链留给首个相关 ticket-design。
- Harness 是日常工程观察与控制产品层。V0 不引入 Brain API，不承载新的独立 Orchestrator；长期自有 Emilia Runtime 与 Brain 可替换方向保留，但不是本版本交付前提。
- 沿用 Workflow v1.1 职责：Emilia 负责目标理解、编排、确定性电脑操作、状态与证据核验、checkpoint、Acceptance 和质量门禁；正式工程调查、设计实现、工程测试及专业 Review 主要由具体工程 Agent 承担。
- 角色与执行能力分开：Emilia 不绑定 Brain Provider；Sylvia 专指 Codex 家族，DS 酱对应 DeepSeek / DSH。不同工程角色可实现同类能力契约，不以一个永久工程人格代表所有 Provider。
- YCA 的电脑能力继续通过 MCP 复用；不为抽象而重写当前 Codex 链路。未来工程 Agent 可评估 ACP / adapter，但协议不拥有 Harness 的历史或 Workflow 语义，具体身份不硬编码为 Core 的通用身份。
- 后台在 Windows 登录后启动并独立于 UI 驻留。自启只负责采集、持久化、恢复连接与观察，不自动请求模型、创建或续跑 Ticket，也不隐式改变既有服务自动恢复策略。
- Project / Ticket 归属以 Emilia 发起任务时显式登记为准。cwd、Git、branch、checkpoint 只辅助填充和校验；冲突提示 attribution mismatch，不静默重归属。
- Ticket 表示工作范围与验收目标；Conversation 是长期协作单元；Agent session / Provider thread 是执行上下文；run 是一次执行；Event Store 保存可观察事件。它们保持关联但不合并为同一种身份。
- 每张 Ticket 有一个长期主 Conversation。底层 session 更换、fresh 或 thread 重建不改变主 Conversation 身份，切换边界必须可见。
- Full Review 使用关联子 Conversation；Focused Re-review 使用新的独立子 Conversation，并关联原 Review / finding。只有实际启动 Acceptance Agent 才建立其子 Conversation；Emilia 的确定性验收不虚构 Agent session。独立 Standards / Spec reviewer 存在时可关联实际子会话。
- 父子 Conversation 表示归属与隔离，不触发上下文继承。保留 ticket-design → implementation continuity、fresh Review、fresh focused re-review、Review routing 及基于外部事实的 Acceptance；界面关系不改写 Workflow 门槛。
- 观察边界内实际收到的任务消息、Agent 回复、session / run 生命周期、模型与 reasoning 档位、工具调用与结果、stdout / stderr / exit code、错误、重试、取消或停止、Workflow phase、checkpoint、Review mode / finding、Acceptance、closeout 均应可追踪，并关联可获得的时间与执行者身份。
- UI 折叠或摘要不丢弃底层已接收记录。来源未提供、尚未收到、采集失败、保存失败、脱敏、截断、主动清理分别表达；来源本身存在限制时不伪造完整历史或不可证明的跨来源顺序。
- 不获取、推测或伪造 hidden chain-of-thought。Provider 明确暴露的 reasoning 可作为可选能力展示，不是 Core 必需内容，也不是实际执行或 Acceptance 的替代证据；其具体接入与展示保持 deferred。
- 工程事件默认长期在本机保存，不设默认自动过期。后续按 Project / Ticket 主动清理；任何脱敏、截断、保存失败或清理均留下完整性提示。长期事件历史不等于 Memory，也不把完整运行日志复制进 checkpoint 或长期 closeout 摘要。
- durable recording 的健康是新有副作用工程动作的系统级前提，覆盖 Harness 与 ChatGPT Emilia → YCA 外部入口。不可可靠持久化时明确进入 degraded / recording-failed，拒绝新的写文件、实现、commit、push、再次执行等动作。
- 记录故障期间只读观察与核对可继续；已有 Agent / run 不因该故障被粗暴强杀，尽量观察安全终态并明确证据缺口。不得承诺停止已经发生的副作用，或在存储不可写时仍完整保存所有事件。
- 记录恢复不直接触发执行。Emilia 先核对真实 Git / YCA / runtime / checkpoint、finding、原授权与 unknown side effects，再决定是否继续；状态不明时不盲重放。
- Harness 可重连、重新订阅、刷新、停止已有 run、打开 worktree；恢复观察不等于恢复执行。停止请求不冒充已确认停止，不回滚既有副作用，也不表述为可无损续跑的暂停。
- Harness 提供日常服务管理入口，底层完全复用 Control Center / Supervisor 的 ownership、release、restart、update、recovery 与既有授权和活动任务检查。禁止第二套 Supervisor；Control Center 保留高级维护与故障排查定位。
- Changes 默认展示 Ticket 从固定比较基线到当前的累计净变化，保留 run / commit 下钻。Workflow fixed_point 服务于 Ticket / Review 比较，不自动作为每次 run 的起点；产生 commit 不意味着整票变化清零。
- Git 与实际文件是当前内容和差异的主要事实来源。工具事件用于关联过程，Agent 自述不能直接证明贡献；既有修改、并发编辑和证据缺口应显示归因不确定。Changes 不承诺重建未被观察的每一次中间编辑。
- Event Store 证明已记录的观察历史，不取代当前外部事实：执行状态核对 YCA / runtime，代码状态核对 Git / 文件，服务 ownership 与版本核对现有管理机制，Review / Acceptance 核对适用产物与证据。checkpoint 是恢复导航而非永久事实。
- 动态状态必须带有可追溯来源及观察时效。重连、恢复或相关环境变化后刷新、核验；无法确认或来源已失效时明确显示未知或过期，不以缓存成功值冒充当前可用状态。
- 默认首页是按 Project 分组的全局总览，突出项目内异常与待处理 Tickets。Ticket 详情以 Conversation 为主，Changes / Workflow 常驻辅助，子 Conversation 为关联入口；不固定栏数或标签页形式。
- 事件契约、存储引擎、进程通信、自启实现、门禁落点、Changes 起点快照与归因算法、安全内容过滤、管理按钮清单和具体布局均留待 ticket-design；本 Spec 不替它们选择实现。

## Testing Decisions

**Primary seam：Yuki Harness 的产品级端到端公开使用边界。** 从外部工程任务入口登记并产生事件，经后台采集与持久化，在首页、Ticket Conversation、Changes、Workflow 和管理入口观察结果。验证用户看见的事实及动作效果，覆盖后台与 UI 生命周期，不将 Event Store 内部接口作为首要验收面。UI 自动化技术与具体通信形式仍由后续 ticket-design 确定。

主验收应覆盖以下已确认行为，尽量用一条代表性 Ticket 协作链串联，不另造无关矩阵：

1. Windows 登录后后台开始观察，UI 未打开或关闭期间持续记录；重开 UI 可恢复已持久化历史。自启、重连与历史补齐不产生新模型请求或工程执行。
2. 从 Project 总览进入 Ticket，查看主 Conversation、常驻 Changes / Workflow 及关联 Review。实际收到的各类事件可追踪，折叠和摘要不删除记录；来源缺失、未收到、采集或保存失败及内容处理提示不会被误读为没有发生。
3. Emilia 的显式归属持续有效；cwd / Git / checkpoint 冲突可见，不自动改归属。多 Project 的代表性记录在首页保持正确分组，不扩展为负载测试。
4. 主 Conversation 在底层 session 切换后身份和历史仍连续；fresh Review / Focused Re-review 关联正确且不继承主上下文。Emilia 直接 Acceptance 不产生虚构 Agent 会话，实际独立验收者才建立关联。
5. Ticket Changes 与真实 Git / 文件的累计净变化一致，包含期间 commit 的影响，可下钻 run / commit；对原有修改、并发变化或证据缺口不作虚假归因。具体比较夹具随后续快照设计确定。
6. recording failure 在 UI 及 ChatGPT → YCA 外部入口拒绝新的有副作用工程动作；真实文件或其他可核验效果保持未发生。只读仍可用，已有 run 不被该故障粗暴强杀，证据缺口可见。
7. 记录恢复后先核验外部事实；未知副作用不自动重放，自动重连不等于再次执行。只有 Emilia 在原授权范围内核验后发起的新工作才可继续。
8. Harness 的停止、刷新、打开 worktree 与服务管理产生相应公开结果；停止状态以真实终态确认，服务管理仍由现有唯一管理者完成，不因新 UI 绕过 ownership、活动任务或授权检查。
9. 历史在产品重开及后台恢复后仍可读取，不因默认过期策略消失。脱敏、截断、保存失败及后续主动清理的完整性语义按其交付范围验证，不把清理工具或具体过滤算法提前扩入本轮。

**必要 secondary seams，仅补充主 seam 不易可靠定位的外部契约：**

- **YCA MCP 公共执行与观察边界**：验证外部入口的 recording 门禁、只读可用性、运行中任务处置、重连与不重放。以受控文件、命令效果、run 状态和公开输出核对；定向覆盖 Codex 执行入口、直接可写操作与受管任务等可能绕过 UI 的路径，不把禁用按钮视为系统级门禁证据。
- **现有 Control Center / Supervisor 公共管理边界**：验证 Harness 转达管理意图后仍保留唯一 ownership、running / selected 版本区别、restart / update 语义及活动任务检查。优先复用已有管理验收，不重跑与 Harness 集成无关的恢复和压力矩阵。

Git / 文件、Workflow 产物与 YCA 事件作为上述验收的外部事实，不额外设立每个内部模块的测试层。持久化故障可用隔离环境的受控失败验证，但不固定数据库、表结构、事件序列化字段、内部函数、mock 调用次数或固定 session / run 标识，也不测试隐藏推理或提示词原文。

测试先例来自现有 YCA 的真实 MCP 客户端、断线不重放与持久化失败测试，Control Center 的隔离真实 YCA 和 ownership / release 验收，以及 Workflow v1.1 的 checkpoint 恢复、fresh reviewer 和外部事实 Acceptance。确定性测试使用隔离仓库、runtime 与可控事件源；只有 session / Agent 行为本身属于验收目标时才增加必要真实模型验收。模拟客户端通过不替代 ChatGPT → 既有 YCA 的代表性真实链路验收；单次验收通过不等于长期稳定。

## Out of Scope

- V0 引入 Brain API、通过 OpenAI API 复制 ChatGPT Emilia，或把自有 Emilia Runtime 的完整迁入作为前置。
- 把现有 ChatGPT 完整聊天界面嵌入 Harness，或获取平台未暴露的全部消息、工具活动、隐藏推理。
- 让 Harness 成为第二个独立 Orchestrator、发起新工程任务、自动续执行或绕过 Workflow / Owner 授权。
- 新建第二套 YCA / tunnel Supervisor，重造既有服务管理体系，或为通用抽象重写当前 Codex 链路。
- V0 正式接入 DSH / DS 酱、落实 ACP adapter 的具体契约与兼容矩阵；不将未来可替换性误写为本版多 Provider 均已可用。
- 完整 Yuki Memory、Companion / Engineering Memory 分层、DeepSeek API PoC、ChatGPT 长期 Channel、微信与 Live2D。
- 在本 Spec 固定 Provider-exposed reasoning 的具体事件格式或显示实现。
- 在本 Spec 固定存储引擎、事件 schema、进程拓扑与通信、自启技术、记录门禁位置、Changes 快照及未跟踪文件算法、secret / token / password、超大输出和二进制正文处理细则。
- 无差别记录全部电脑活动、保证来源未提供的过程完整、仅凭净 diff 精确归属每次修改，或自动重放未知副作用。
- 以本地日志替代当前外部事实，或把一次通过、界面健康、run completed 表述为 Acceptance 已通过或长期 stable。

## Further Notes

- 设计 source of truth：[Yuki Harness V0 Design Handoff](../design/yuki-harness-v0-handoff.md)；其 shared understanding 已由 Owner 确认，Unresolved 无阻塞项。本 Spec 综合持久化输入，不重新采访，也不把讨论中的未确认建议升级为决定。
- 领域词遵循 [CONTEXT](../../CONTEXT.md)。结构与依赖方向参考 [architecture](../architecture.md)；Harness 的本地工程事件历史不意味着扩大全部生活能力的日志采集范围。
- 复用依据：[YCA README](../../tools/codex-session-bridge/README.md)、[Control Center README](../../tools/control-center/README.md)、[Workflow v1.1 Spec](emilia-sylvia-workflow-v1.1.md)。Workflow 的实际交付边界另见 [WORKFLOW-006 验收记录](../tickets/workflow-v1.1/006-local-acceptance.md)，不以旧 Spec 的阶段文字代替后续交付证据。
- 当前 YCA 已有 Codex session / run、请求去重、durable output 与观察等待，但直接电脑审计主要保存元数据，受管任务输出有服务生命周期和保留限制；它们不是完整的长期 Event Store。V0 需要补齐已确认观察范围的采集与记录，不得假设 UI 可以从现有日志还原所有历史正文。
- 当前 Control Center 是既有服务管理事实来源，并非完整工程聊天控制台；当前 Workflow 已有产物、恢复与验收机制，也不等于 Harness 后台状态管理已实现。动态版本、进程与可执行程序位置必须在实施和验收当时重新核验。
- 本文是待实施需求，不宣称 Harness 代码已实现、已真实端到端验收或已日常稳定。后续报告必须分别记录 implemented、accepted、stable，不能从任何一级自动推到下一级。
- Genuine unresolved：无阻塞形成 Spec 的高杠杆产品或架构未决项。上述 deferred 是已识别的后续实现级设计工作，不等于相应 V0 行为可以省略。若实现调查发现无法满足已确认门槛，应明确回报，而不是静默缩小范围。
- 正式 Spec 路径为 `docs/specs/yuki-harness-v0.md`；已发布到 GitHub Issue #39，并应用 `ready-for-agent` label。11 张 V0 Ticket 已发布，索引见 `docs/tickets/yuki-harness-v0/README.md`。
- `to-tickets` 已完成。当前 frontier 为 **HARNESS-001 / #40**；下一步在新的独立实现 worktree 中执行 #40 `ticket-design`，运行期 checkpoint 由后续实际交接维护，不写入领域词汇表。

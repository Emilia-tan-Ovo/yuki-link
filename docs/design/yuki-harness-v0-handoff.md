# Yuki Harness V0 · Design Handoff

状态：**pair-with-docs、`to-spec`、`to-tickets` 均已完成；正式 Spec 为 GitHub Issue #39，当前 frontier 为 HARNESS-001 / #40。**

日期：2026-09-19

## 目标

Yuki Harness 的长期目标是成为桓宇与 Emilia 及工程 Agent 协作的主要入口与统一控制界面，并逐步把工程协作、事件历史、Memory、Channel 与表现层从外部客户端迁入自有系统。

V0 不直接替代现有 ChatGPT Emilia，而是先交付一个 Windows 本地工程控制台：持续观察、记录并展示 Emilia → YCA → 工程 Agent → Workflow 的可观察工程链路，减少 ChatGPT 客户端断线、审核或界面异常带来的“看不见、接不上、无法判断是否还在工作”的问题。

## V0 范围

- Windows 登录后自动启动后台 Runtime；UI 关闭后后台继续采集和持久化事件。
- 重开 UI 后恢复观察，并补齐后台已持久化的可用历史。
- 首页提供按 Project 分组的全局总览；Project 下展示各 Ticket 的推进状态与异常。
- Ticket 详情以 Conversation 为主工作面，Changes 与 Workflow 状态常驻辅助。
- Review、Focused Re-review、必要的 Acceptance Agent 以关联子 Conversation 形式展示。
- Harness 可观察、重连、刷新、停止已有 run，并提供日常 YCA / tunnel / version / restart / update 等管理入口。
- 日常服务管理底层继续复用现有 Control Center / Supervisor；不得新建第二套并行管理同一 YCA 进程的 Supervisor。
- Harness V0 不作为新工程任务的发起入口；新的工程意图仍由 ChatGPT 中的 Emilia 发起。

## 已确认角色与职责

### Emilia

- Emilia 是 Yuki Harness 长期稳定的主交互与编排角色，不绑定某一家 Brain Provider。
- V0 继续使用 ChatGPT 中现有的 Emilia 作为实际 Orchestrator，以保留当前记忆与已经磨合好的三人协作体验。
- Emilia 继续负责：理解目标、Workflow 编排、确定性电脑操作、Git / 文件 /状态核对、checkpoint、Acceptance 与质量门禁。
- 正式 repository engineering 不由 Emilia 承担主责。

### 工程 Agent

- 工程角色跟具体 Agent / Provider 家族绑定，而不是抽象成一个永久人格。
- Codex 家族对应 **Sylvia（希尔薇娅）**。
- DeepSeek / DeepSeek Harness 家族对应 **DS 酱**。
- 不同角色可实现同一类 Engineering Agent 能力契约。
- 正式工程调查、设计实现、大量代码修改、工程测试与专业 Review 主要由对应工程 Agent 完成。

## 接入与协议边界

- 现有 YCA 的 PowerShell、Filesystem、Git、Owned Task 等电脑能力继续作为 MCP 能力复用。
- V0 不为抽象而重写现有 Codex 链路。
- 工程 Agent 未来优先评估 ACP / adapter 方向，但 ACP 只作为一种接入方式，不承担 Harness 的历史、Workflow 或 Event Store 语义。
- ChatGPT、Codex、DeepSeek / DSH 都不得成为未来 Harness Core 的硬编码身份。
- V0 暂不引入 Brain API。
- 未来第一次接入自有 Brain 时优先评估 DeepSeek API；OpenAI API 不作为 V0 前置。

## 技术栈方向

- **Yuki Harness 的新增与新建长期代码默认以 TypeScript 为主。**
- 现有 YCA / Control Center 的 JavaScript 代码继续视为受支持的稳定实现；Harness V0 不以一次性将它们全部重写为 TypeScript 为前置。
- 既有 JavaScript 可在后续有明确收益时渐进迁移到 TypeScript；迁移必须保持当前公开行为、MCP / Control Center 契约与真实验收结果，不因语言统一扩大 scope。
- TypeScript 与现有 JavaScript 的模块边界应保持可互操作；具体 `tsconfig`、运行/构建方式、是否直接执行 `.ts`、是否使用额外 loader / compiler 等工具链细节留给首个相关 `ticket-design`。
- 该决策的目的是真正利用 Harness 中 Project / Ticket / Conversation / Run / Event / Workflow 等长期状态模型的静态类型收益，而不是为了技术栈整齐重写已稳定代码。

## 可观察过程与 Event History

### 完整性原则

对已经纳入 V0 观察边界、并且系统实际收到的事件，Harness 不应因为 UI 折叠或摘要而丢弃底层记录。

至少覆盖：

- Emilia → 工程 Agent 的可见工程任务消息；
- 工程 Agent 的可见回复；
- Agent session / run 生命周期；
- 模型与 reasoning 档位等可观察配置；
- tool call、tool result、stdout / stderr / exit code；
- error、retry、cancel / stop；
- Workflow phase；
- checkpoint；
- Review mode / finding；
- Acceptance；
- closeout；
- 时间戳及可关联的 session / run / actor 身份。

必须区分：

- 来源未提供；
- 尚未收到；
- 采集失败；
- 保存失败；
- 脱敏；
- 截断；
- 主动清理。

不能把上述情况统一显示成“没有发生”。

### 思考过程

- 平台未公开的 hidden chain-of-thought 不获取、不推测、不伪造。
- Provider 明确暴露的 reasoning / reasoning_content / thinking event 可作为可选能力展示。
- Provider-exposed reasoning 不等于完整内部推理，也不能作为 Git、测试、文件或 Acceptance 的替代证据。

### 长期保留

- V0 工程事件历史默认长期保存在本机，不设置自动过期时间。
- 后续按 Project / Ticket 主动清理。
- 脱敏、截断、保存失败或主动清理必须保留完整性提示。

## Recording 门禁

Recording / Event Store 的可持久化健康状态是**新的有副作用工程动作**的系统级前置条件。

当 durable recording 无法可靠工作时：

- 进入 degraded / recording-failed 状态；
- 不再启动新的写文件、实现、commit、push、再次执行等有副作用工程动作；
- 该门禁不仅约束 Harness UI，也必须覆盖 ChatGPT Emilia → YCA 的外部入口；
- 只读观察与状态核对可以继续；
- 已经启动的 Agent / run 不因记录故障被粗暴强杀，应尽量观察到安全终态；
- 明确记录证据缺口；
- 恢复后先重新核验 Git / YCA / runtime / checkpoint / unknown side effects，再决定是否继续；
- 不盲目重放可能已经产生副作用的动作。

具体门禁实现位置留给 Spec / ticket-design。

## 工程任务归属

- Project / Ticket 归属以 Emilia 发起工程任务时的显式登记为准。
- Harness 可根据 cwd、Git、branch、Workflow checkpoint 等自动辅助填充和校验。
- 自动发现不得静默改变归属。
- 发现登记与事实不一致时应明确提示 attribution mismatch。

## Change View

默认回答：**一整张 Ticket 从开始到当前累计改了什么。**

- Ticket 累计 Changes 是默认主视图。
- 单个 run / commit 保留下钻入口。
- Git 是最终文件状态与 diff 的主要事实来源。
- Workflow fixed_point 可作为 Ticket / Review 比较基线，但不自动等同于每次 run 的起点。
- 当前 Git diff、工具事件与 Agent 自述不能直接等同于“某个 Agent 的贡献”。
- 存在用户原有修改、并发编辑或证据缺口时，应明确标注归属不确定，不能硬猜。

Changes 起点快照、脏工作区比较、未跟踪文件内容和归因算法留待后续设计。

## Conversation 模型

### Ticket 主 Conversation

- 一张 Ticket 对应一个长期稳定的主 Conversation。
- 主 Conversation 可跨多个底层 Agent session / Provider thread 持续存在。
- session 切换、fresh context 或 provider thread 重建需要明确记录边界，但不会新建另一张 Ticket 主 Conversation。

### 子 Conversation

- Full Review 作为关联子 Conversation。
- Focused Re-review 使用新的独立子 Conversation，并与原 finding / Review 建立关联。
- Acceptance 只有在实际启动 Acceptance Agent 时才建立对应子 Conversation；Emilia 直接 deterministic Acceptance 不虚构 Agent session。
- Full Review 内若 Standards / Spec 轴确实对应独立 reviewer session，可继续关联实际子会话。

父子 Conversation 只表示任务关联与隔离边界，**不代表上下文继承**。fresh reviewer 仍只能获得 Workflow 明确允许的 fixed point、diff、Ticket / Spec、标准和必要测试证据。

底层对象含义保持区分：

- Ticket：工作范围与 Acceptance Criteria；
- Conversation：用户可长期回看的协作单元；
- Agent session / Provider thread：具体 Agent 持有的上下文；
- Run：session 中的一次执行；
- Event Store：保存上述对象产生的可观察事件，不等同于一个聊天会话。

## 控制边界

Harness V0 可以：

- 查看与恢复观察；
- 重新连接 / 重新订阅已有 session / run；
- 刷新状态；
- 停止已有 run；
- 打开 worktree；
- 展示并调用日常 YCA / tunnel / version / restart / update 管理入口。

Harness V0 不自行：

- 创建新的工程任务；
- 判断“继续执行下一步”；
- 绕过 Workflow / Owner 授权门槛。

真正会再次让 Agent 执行新工作的“续跑”仍由 Emilia 核对 checkpoint、Git / YCA / runtime 真实状态、finding、原授权范围和 unknown side effects 后发起。

## 首页与 Ticket 详情

### 全局首页

- 默认打开全局总览，而不是直接回到上次 Ticket。
- 首页按 Project 分组。
- 每个 Project 下展示 Tickets 及 phase、running、finding、accepted、recording / 系统异常等状态。
- 异常与待处理 Ticket 在所属 Project 内突出显示。

### Ticket 详情

- Conversation 是主工作面。
- Changes 与 Workflow 常驻辅助。
- Review / Focused Review 等子 Conversation 提供关联入口。
- 当前只确认信息主次，不锁死三栏、两栏、标签页或具体视觉布局。

## 与现有系统的关系

- YCA 继续作为电脑能力与当前 Codex bridge 的核心可复用底座。
- Workflow v1.1 的 checkpoint、fresh Review、Review routing、deterministic Acceptance、closeout 等语义继续复用。
- Control Center / Supervisor 继续作为 YCA / tunnel / release / ownership / recovery 的唯一底层服务管理机制。
- Harness 是新的日常观察与控制产品层，不把现有能力全部重造一遍。

## 明确 Deferred

以下方向已认可，但不阻塞 V0：

- Brain Provider 抽象的实际实现；
- 自有 Emilia Runtime 真正迁入 Harness；
- DeepSeek API PoC；
- Yuki Memory；
- Companion Memory 与 Engineering Memory 的正式分层；
- ChatGPT 外部 Channel 的长期形态；
- 微信 Channel；
- Live2D 表现层；
- DSH / DS 酱正式接入；
- ACP adapter 的具体契约与兼容测试；
- Provider-exposed reasoning 的具体事件 schema 与展示方式。

## V0 明确 Out of Scope

- 将现有 ChatGPT 完整聊天界面嵌入 Harness；
- 捕获 ChatGPT 平台未向我们暴露的全部消息、工具活动或隐藏推理；
- 用 OpenAI API 复制当前 ChatGPT Emilia；
- 为了 V0 建设完整 Memory 系统；
- 让 Harness 成为第二个独立 Orchestrator；
- 新建第二套 YCA / tunnel Supervisor；
- 微信、Live2D 与陪伴形态；
- 将一次 V0 验收扩大描述为长期 stable。

## 测试 Seam

已确认的 V0 关键测试方向：

- UI 关闭后，后台仍能继续记录并在重开后恢复已持久化历史。
- 已收到的 observable trace 不因 UI 折叠而丢失；缺口类型可区分。
- recording failure 会阻止新的有副作用动作，包括 ChatGPT → YCA 外部入口；只读仍可用，已有 run 不被粗暴强杀。
- Ticket 显式归属与 cwd / Git / checkpoint 校验发生冲突时，不静默重归属。
- Ticket Change View 能展示从固定比较基线到当前的累计净变化，并保留 run / commit 下钻。
- Ticket 主 Conversation 跨底层 session 切换仍保持同一身份；fresh Review 子 Conversation 不继承主上下文。
- Harness 日常服务管理必须走现有 Control Center / Supervisor，不出现双管理者。

具体事件 schema、存储引擎、进程通信、Windows 自启实现、UI 自动化 seam、Changes 快照算法和安全内容过滤留待 Spec / ticket-design 进一步固定。

## 领域文档 / ADR

- 已更新根 `CONTEXT.md`：补充 Yuki Harness、Emilia、工程 Agent 角色、Sylvia、DS 酱、Conversation 等领域词。
- 当前没有必须新建的 ADR；本轮尚未出现同时满足“难以逆转、缺上下文会令人意外、存在真实不可忽略取舍”的已落地实现决策。若 `to-spec` 或 ticket-design 固定长期不可逆技术边界，再重新评估。

## Unresolved

无阻塞 `to-spec` 的高杠杆产品 / 架构未决项。

## 下一步

正式 Spec 已写入 `docs/specs/yuki-harness-v0.md` 并发布为 GitHub Issue #39；11 张 V0 Ticket 已发布，索引见 `docs/tickets/yuki-harness-v0/README.md`。当前 frontier 为 HARNESS-001 / #40；下一步在新的独立实现 worktree 中进入 #40 `ticket-design`。

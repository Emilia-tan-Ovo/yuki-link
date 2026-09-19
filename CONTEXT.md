# yuki-link

连接个人设备与生活服务的统一能力系统。

## Language

**yuki-link**：项目与仓库统一使用的名称。

**Yuki Windows**：现有的 Windows 自定义接入名称；不等同于 Windows-MCP 上游项目，也不等同于整个 yuki-link。

**Yuki Harness**：面向桓宇的主要交互入口与统一控制界面；承载与 AI 角色的可见对话，并汇集工程协作、工具活动与恢复状态。它不等同于某一家模型、ChatGPT 客户端或某一个工程 Agent。

**Emilia（艾米莉亚）**：Yuki Harness 长期稳定的主交互与编排角色；其角色身份不绑定某一家模型或 Brain Provider。

**工程 Agent 角色**：负责仓库调查、设计、实现、审查等工程工作的可替换执行角色；角色形象可以绑定具体 Agent / Provider 家族，而不是统一为一个永久人格。

**Sylvia（希尔薇娅）**：Codex 家族对应的工程 Agent 角色与形象；不泛指所有 repository engineer，也不用于 DeepSeek Harness。

**DS 酱**：DeepSeek / DeepSeek Harness 家族对应的工程 Agent 角色与形象；与 Sylvia 是不同角色，但两者可以实现相同的工程 Agent 能力契约。

**Conversation（协作对话）**：Yuki Harness 中长期持久化的协作单元。Ticket 主 Conversation 可跨多个底层 Agent session 持续存在；Review 等子 Conversation 表示任务关联与隔离边界，不表示自动继承父 Conversation 的完整上下文。

**设备（Device）**：用户可以连接并执行操作的具体电脑或手机；设备类型并不决定生活能力的归属。

**能力（Capability）**：用户要完成的事情，例如设置闹钟、安排出行、订餐或记账；可以存在多种实现途径。

**服务（Service）**：围绕某项能力组织的业务规则与操作流程；可以由设备操作或外部服务完成。

**提供方（Provider）**：声明并实现一组能力的具体接入方，可以对应设备，也可以对应外部服务。

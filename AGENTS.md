# 项目协作约定

- 除必须保留英文的技术名词、代码、协议字段、外部原文等内容外，项目文档与说明优先使用中文。
- Git 提交可以保留 `feat:`、`fix:`、`test:`、`docs:`、`chore:` 等 Conventional Commit 类型前缀；冒号后的提交主题与正文优先使用中文。历史提交不改写。
- 对外部环境派生的动态状态（如可执行文件路径、远端 commit、selected/running release、进程身份）必须明确 source of truth、刷新/失效语义和变化后的回归测试；不得把一次探测结果当作永久稳定配置。
- 能力说明必须区分“代码已实现”“已走真实链路验收”“已在日常场景稳定使用”。未完成真实端到端验收时不得用更高一级的表述。

## 工作流成本与范围护栏

- Owner 的时间、注意力和模型额度是一等工程资源；满足当前 Ticket Acceptance Criteria 后优先停止，不追求“证明得更完整”。
- 当前 Ticket 范围以 Ticket/Spec 的目标和 Acceptance Criteria 为边界；相邻风险、压力测试、drift/recovery、额外 fixture 矩阵、工作流研究如果不直接阻塞当前验收，只记录 follow-up，不在当前票执行。
- 普通 Ticket 默认模型预算：ticket-design→implement 尽量复用一个 implementation session；Review 只进行一次必要的 fresh primary review；有 finding 时最多再进行一次 fresh focused re-review。Acceptance 默认由 Emilia 使用 Git、文件、命令、测试和 YCA 外部事实直接核对；只有 criteria 本身要求 Agent/session 行为时，才额外启动验收模型。
- Git/status/diff、测试、commit、push、Skill apply/verify、PR/merge、Issue closeout 等能由确定性工具完成的机械动作，不得为了方便启动模型。
- fresh reviewer 只接收 fixed point、目标 diff/内容身份、Ticket/Spec、标准和必要测试证据；不得重复提供完整聊天、大型日志或无关历史。
- 高成本模型、更高 reasoning 或额外并行 Agent 不是普通 Ticket 的默认选项；明显增加成本前必须说明必要性并取得 Owner 明确同意。
- Owner 明确说“收尾”“别扩范围”“我要休息/睡觉”等同类表达时，立即 stop-expansion：禁止新增 scope、fixture、测试矩阵、reviewer 或旁支调查，只处理当前 blocker、checkpoint 和必要 closeout。
- ChatGPT UI 异常、观察超时、网络或审查中断不构成重启任务的理由；先检查 durable run/session/checkpoint，避免重复副作用和模型调用。
- 面向 Owner 的过程更新默认只说明：现在在做什么、为什么这是当前票必须的、还剩什么；除非 Owner 主动询问，不使用低层 workflow 术语增加监督负担。

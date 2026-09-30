# 项目协作约定

- 除必须保留英文的技术名词、代码、协议字段、外部原文等内容外，项目文档与说明优先使用中文。
- Git 提交可以保留 `feat:`、`fix:`、`test:`、`docs:`、`chore:` 等 Conventional Commit 类型前缀；冒号后的提交主题与正文优先使用中文。历史提交不改写。
- 对外部环境派生的动态状态（如可执行文件路径、远端 commit、selected/running release、进程身份）必须明确 source of truth、刷新/失效语义和变化后的回归测试；不得把一次探测结果当作永久稳定配置。
- 能力说明必须区分“代码已实现”“已走真实链路验收”“已在日常场景稳定使用”。未完成真实端到端验收时不得用更高一级的表述。

## 工作流项目覆盖

- 新建、续发、拆分、交接、换代或恢复工程执行前，读取所选同根 engineering-workflow 的工作项生命周期协议；仓库版本源为 [.workflow/skills/engineering-workflow](.workflow/skills/engineering-workflow/SKILL.md)，全局目录仅为安装产物。不同版本不可混用。
- 通用状态机、恢复和领域职责在 Skill 包维护，本文件不重复定义。Work Item runtime gate 的接口、适配要求与验收级别见 [Bridge 工具契约](tools/codex-session-bridge/README.md#工具)；不能把文档规则或契约测试误报为生产链路已验收。
- 当前 Ticket 范围以 Ticket/Spec 的目标和 Acceptance Criteria 为边界；相邻风险、压力测试、drift/recovery、额外 fixture 矩阵、工作流研究如果不直接阻塞当前验收，只记录 follow-up，不在当前票执行。
- **模型路由固定为：GPT-6.1 Sol high 主力、Astra 升级。** 普通 ticket-design / implementation / finding fix / focused review / full review 默认使用 `gpt-6.1-sol high`。只有 6.1 Sol high 明显不足，或任务本身属于最困难的并发/一致性/安全/跨系统疑难问题时，才允许升级到 `gpt-6-astra`，且启动前必须向 Owner 说明理由并取得明确批准。默认禁止 `xhigh/max/ultra`；`gpt-5.6-luna` 与 `gpt-5.6-terra` 禁止使用；其他未列模型只有 Owner 明确改变策略后才可使用。
- Full Access 只表示执行能力，不扩大任务授权：scope、不可逆操作、GitHub merge/deploy、生产配置等仍受 Ticket/Owner gate 约束。权限能力与行为授权分开管理。
- **默认最多一条活跃 Codex 模型工作线。** “允许并发”只表示上限，不是默认行为；第二条模型线必须有明确关键路径收益，并在启动前取得 Owner 明确批准。YCA 的确定性工具调用不算模型并发。
- fresh worktree 默认建立在仓库 allowlist 内的 `.local/worktrees/<ticket-or-maintenance>`；Context Plan / prompt 中代码与测试入口必须写完整 repo-relative path，不依赖隐含 cwd。
- **普通 Ticket raw input 成本参考目标：** ticket-design ≤1.5M、implementation ≤3M、primary Review ≤2M、finding fix ≤1M、focused re-review ≤0.7M，整票累计目标 ≤6M。以上均为诊断与优化目标，**不是硬上限，也不因超过固定数字自动禁止下一次模型 run**。阶段或整票明显高于目标、出现重复肥上下文/异常暴涨，或消耗与当前任务规模明显不相称时，标记 `cost anomaly`，在下一次模型调用前简短说明主要消耗来源、继续的必要性与收缩方案；复杂或大票可合理超标。只有出现明显失控或无效重复时才暂停扩展并先收缩，不以 3M/6M 等固定数字机械熔断。raw/cached/output usage 由 YCA durable run status 记录；这些数字是工程诊断指标，不等同于产品周额度的 1:1 token 计费。
- 仓库工程执行继承 Owner 本机原生权限并在创建 session 时冻结；正常编排路径的 gate 不修改 Owner Full Access。权限来源变化按生命周期协议处理，不能静默降级。
- 创建 Codex session 时优先省略 `permissions`，由 YCA 解析并冻结 Owner 当前本机默认；具体权限值从当前事实读取，不硬编码。
- GitHub 写入默认由已认证的 Emilia + YCA direct 完成；只有确需 Repository Engineer 自己操作且其认证已单独验证时才交给模型。
- 本项目 runtime gate 在现有 ExecutionOperations / WorkflowAgentLauncher 与执行 journal 上扩展；transport manager 仅提供通用 guarded start/send seam，不承载工作流状态机，不另建并行状态库。
- PowerShell 使用 pwsh.exe，文本读写显式 UTF-8；优先使用项目已就绪的宿主工具与依赖。GitHub/部署等外部写入仍以本轮具体授权为界。
- 工作项达到完成条件后停止扩展。Owner 明确要求收尾时，只处理当前范围、checkpoint 与必要交接。

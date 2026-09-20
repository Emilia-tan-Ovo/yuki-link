# 项目协作约定

- 除必须保留英文的技术名词、代码、协议字段、外部原文等内容外，项目文档与说明优先使用中文。
- Git 提交可以保留 `feat:`、`fix:`、`test:`、`docs:`、`chore:` 等 Conventional Commit 类型前缀；冒号后的提交主题与正文优先使用中文。历史提交不改写。
- 对外部环境派生的动态状态（如可执行文件路径、远端 commit、selected/running release、进程身份）必须明确 source of truth、刷新/失效语义和变化后的回归测试；不得把一次探测结果当作永久稳定配置。
- 能力说明必须区分“代码已实现”“已走真实链路验收”“已在日常场景稳定使用”。未完成真实端到端验收时不得用更高一级的表述。

## 工作流成本与范围护栏

- Owner 的时间、注意力和模型额度是一等工程资源；满足当前 Ticket Acceptance Criteria 后优先停止，不追求“证明得更完整”。
- 当前 Ticket 范围以 Ticket/Spec 的目标和 Acceptance Criteria 为边界；相邻风险、压力测试、drift/recovery、额外 fixture 矩阵、工作流研究如果不直接阻塞当前验收，只记录 follow-up，不在当前票执行。
- **模型上下文不是工作流状态存储。** ticket-design 与 implementation 默认使用不同的 fresh model session；阶段连续性通过 Ticket `Implementation Notes`、checkpoint、Git 与 handoff 保留，不靠复用肥 session。实现 prompt 只给引用、fixed point、当前 delta 与必要约束，不复制完整设计聊天、Issue/Spec/Notes 正文。
- primary Review 必须 fresh；Review finding 的修复也必须使用 **fresh fix session**，只接收 finding、修复基线、受影响文件/规范和最小测试，不得回到原 implementation session 继续背历史。修复后最多再进行一次 fresh focused re-review。
- **模型路由固定为：Sol 主力、Astra 升级。** 普通 ticket-design / implementation / finding fix / focused review 默认使用 `gpt-5.6-sol medium`；复杂跨模块实现或 full review 可使用 `gpt-5.6-sol high`。只有 Sol high 明显不足，或任务本身属于最困难的并发/一致性/安全/跨系统疑难问题时，才允许升级到 `gpt-6-astra`，且启动前必须向 Owner 说明理由并取得明确批准。默认禁止 `xhigh/max/ultra`；`gpt-5.6-luna` 与 `gpt-5.6-terra` 禁止使用；其他未列模型只有 Owner 明确改变策略后才可使用。
- **Codex 仓库工程 session 默认继承 Owner 的本机原生权限，不得被 Orchestrator 静默降级。** 当前 Owner 默认是 Full Access；创建普通 ticket-design / implementation / fix / review session 时，优先省略 `permissions` 让 YCA 解析并冻结本机默认。若必须显式传权限，则应与当前 Owner 默认等价（当前为 `danger-full-access + on-request`），除非 Owner 明确要求更窄权限。禁止为了“更安全”自行改成 `workspace-write` / `read-only`。
- Full Access 只表示执行能力，不扩大任务授权：scope、不可逆操作、GitHub merge/deploy、生产配置等仍受 Ticket/Owner gate 约束。权限能力与行为授权分开管理。
- 新接入的 Repository Engineer（例如后续 DeepSeek Agent）必须遵守同一运行策略：session/finding fresh 边界、成本记录、模型/能力路由、Owner 权限默认和机械工作下放。若其 adapter 不能可靠继承并冻结 Owner 权限、不能暴露 run/usage/side-effect 事实，则不得宣称工作流兼容完成。
- **默认最多一条活跃 Codex 模型工作线。** “允许并发”只表示上限，不是默认行为；第二条模型线必须有明确关键路径收益，并在启动前取得 Owner 明确批准。YCA 的确定性工具调用不算模型并发。
- Git/status/diff、hash、checkpoint/closeout、GitHub Issue/PR/merge/close、完整测试套件执行与大型日志提取等可由 Emilia + YCA 确定性完成的机械动作，不得为了方便启动模型。实现模型只运行直接驱动红→绿所需的最小定向测试；full suite 与长日志默认由 YCA 执行并只把摘要/失败切片交给模型。
- **fresh worktree / fresh model session 启动前先做 0-token 环境 preflight。** Emilia + YCA 必须先核对 fixed point/HEAD、项目依赖是否就绪、当前任务需要的宿主工具是否真实存在、长任务是否应走 owned task、以及 GitHub 等外部动作应由哪一层执行。缺 `node_modules` 等依赖时先用项目既有确定性方式准备；不得把“让模型进去以后自己发现环境没准备”当正常流程。
- fresh worktree 默认建立在仓库 allowlist 内的 `.local/worktrees/<ticket-or-maintenance>`；Context Plan / prompt 中代码与测试入口必须写完整 repo-relative path，不依赖隐含 cwd。
- 不假设工具存在：当前宿主没有 `rg` 时直接使用 PowerShell/Git 等已知 fallback，不让每个 reviewer 先失败一次再改命令。GitHub 写入默认走已认证的 Emilia + YCA direct；只有确实需要 Repository Engineer 自己操作 GitHub 且其认证已经单独验证时才交给模型。
- 避免巨型多层字符串编排：能用专用 filesystem/Git/task 工具就不用 JS→PowerShell→regex/here-string 一锅脚本；必须使用 PowerShell 修改受保护 workflow 文件时，拆成小而可回读的操作，每步用 diff/exit code 校验。
- **机械命令输入格式固定化。** 长 Markdown/JSON/PR body 先用 `filesystem_write` 落临时文件，再让 `gh --body-file` / 脚本读取；不要把 Markdown 反引号、PowerShell here-string、JS template string 嵌在同一层调用里。
- Git revision/range 作为独立参数或先构造单一变量传入；不要写会被 PowerShell 重新解释的 `$base..HEAD`。纯字符串查找优先 `-SimpleMatch` / `.Contains()`，不是必须时不要写 regex。
- YCA/Codex `request_id` 是幂等键：只允许对**完全相同的受保护 payload**复用；payload、cwd、脚本或参数改变时必须生成新的 request_id，禁止“沿用旧名字碰碰运气”。
- 安全 fixture 可能故意包含 credential-like 文本并被 `filesystem_*` 拒绝；这类已知测试源码改用 PowerShell 精确行段读取/修改，不重复撞 `SENSITIVE_CONTENT`。
- **重复 baseline 红项必须有 owner。** 同一 full-suite 失败连续出现在两张 Ticket，或在两个独立 baseline/full-suite 观测中重复出现时，不能继续只记“非本票 blocker”：若是确定性小修复，在下一 frontier 前做 maintenance；否则必须创建明确 follow-up Issue/owner/reference。没有 follow-up 的长期红项不得继续带入下一 Ticket。
- 大型日志、Git history、测试输出、runtime JSONL 和长文件先由确定性工具筛选/压缩；模型默认只接收必要失败片段、结构化摘要和来源引用。不得把完整聊天、完整日志或整份历史重复灌入 fresh session。
- **普通 Ticket raw input 成本参考目标：** ticket-design ≤1.5M、implementation ≤3M、primary Review ≤2M、finding fix ≤1M、focused re-review ≤0.7M，整票累计目标 ≤6M。以上均为诊断与优化目标，**不是硬上限，也不因超过固定数字自动禁止下一次模型 run**。阶段或整票明显高于目标、出现重复肥上下文/异常暴涨，或消耗与当前任务规模明显不相称时，标记 `cost anomaly`，在下一次模型调用前简短说明主要消耗来源、继续的必要性与收缩方案；复杂或大票可合理超标。只有出现明显失控或无效重复时才暂停扩展并先收缩，不以 3M/6M 等固定数字机械熔断。raw/cached/output usage 由 YCA durable run status 记录；这些数字是工程诊断指标，不等同于产品周额度的 1:1 token 计费。
- checkpoint 在每个模型 run 终态后、以及启动下一个模型 run 前，更新本票 `model_usage`：run 数、input、cached input、output、当前模型/reasoning、anomaly 状态。无法取得 usage 时记 unknown，不允许模型自述补造。
- Acceptance 默认由 Emilia 使用 Git、文件、命令、测试和 YCA 外部事实直接核对；只有 criteria 本身要求 Agent/session 行为时，才额外启动验收模型。
- Owner 明确说“收尾”“别扩范围”“我要休息/睡觉”等同类表达时，立即 stop-expansion：禁止新增 scope、fixture、测试矩阵、reviewer、模型升级或旁支调查，只处理当前 blocker、checkpoint 和必要 closeout。
- ChatGPT UI 异常、观察超时、网络或审查中断不构成重启任务的理由；先检查 durable run/session/checkpoint，避免重复副作用和模型调用。
- 面向 Owner 的过程更新默认只说明：现在在做什么、为什么这是当前票必须的、还剩什么；除非 Owner 主动询问，不使用低层 workflow 术语增加监督负担。

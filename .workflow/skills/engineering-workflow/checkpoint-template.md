# Checkpoint schema v1

复制下方模板到当前 worktree 的 `.local/workflow-state/<ticket>.md`。删除示例占位说明，未知字段用 YAML `null` / `[]`；路径和时间用引号。`phase` 仅取 discovery/spec/tickets/ticket-design/implementation/review/acceptance/closeout；finding 修复属于 implementation。`schema_version` 不兼容或字段缺失时先恢复文档证据，不盲目执行 Next action。

```markdown
---
schema_version: 1
ticket: "<ticket 或拆票前 feature 标识>"
phase: ticket-design
worktree: "<当前绝对路径>"
branch: "<实际分支>"
fixed_point: "<已解析 SHA>"
head: "<最近观察的 SHA>"
design_session: null
design_runs: []
implementation_session: null
implementation_runs: []
fix_sessions: []
review_sessions: []
acceptance_runs: []
model_usage:
  runs: 0
  input_tokens: 0
  cached_input_tokens: 0
  output_tokens: 0
  current_model: null
  current_reasoning: null
  anomaly: false
updated_at: "<UTC ISO-8601>"
---

# Confirmed decisions
- Ticket/Spec/Notes/Design Handoff 路径或 URL；已确认约束与必要 deferred details。
- 本轮授权的范围、结束点和仍需 Owner 审批的动作。

# Current evidence
- 证据引用、观察时间、来源、结果和适用的内容身份。Git 是 branch/HEAD/diff 的 source of truth。
- test/review/acceptance 要记录 fixed point、受检 commit；若有未提交内容，附 tracked diff 和相关 untracked 文件字节摘要。仅 HEAD 不足以覆盖脏工作区。
- Review 的两轴结论、原 finding、修复检查及 reviewer 隔离证据；命令退出码与精简报告路径。
- runtime/YCA/session/run 是观察值，附查询入口与最近状态；未使用 YCA 标记不适用，不编造 ID。
- 每个模型 run 终态后，用 YCA durable run status 累加 `model_usage` 的 input/cached/output 与 run 数；这些数字只作工程成本诊断，不等同于产品 quota。启动下一次模型 run 前必须先检查 anomaly 状态和最近一次成本说明。

# Open findings / blockers
- finding 标识、状态（open/fixed/verified）、对应 diff/证据和下一检查。无则写无。
- external interruption 的来源与尚未知事实，不把观察连接失败写成项目失败。
- cost anomaly：任一单 run input >3M 或整票累计 input >6M 时记录原因、收缩方案和 Owner 状态；复杂大票允许超过预算，但必须保留 cost anomaly、说明继续理由并主动缩小下一轮上下文；不设置固定 token 数字作为禁止继续的硬熔断。

# Side effects
- 每个影响恢复的动作：预期目标、状态（pending/completed/unknown）、回执/外部核验入口。
- commit/push/PR/apply 等完成状态必须有证据；响应缺失用 unknown，先核验再重试。

# Next action
- 一条具体动作，包含目标、前置核验和完成标准；存在 Owner gate 时注明具体 preview/diff 和待批范围。
```

执行状态只供导航。测试、Review 和副作用回执必须仍能从原始来源验证；`completed` 字样本身不是证据。记录最少必要身份/引用，不复制凭据、原始会话或大型日志。迁移工作树时保留原记录作为历史，在新树重新建立身份和证据，不改写旧 worktree 来冒充当前执行。

当前 Ticket 已登记 Harness 且阶段边界通过 `harness_record_workflow` 成功保存时，在 `Current evidence` 记录最近的 `workflow_revision`、`event_id`、`cursor` 与观察时间，下一次提交以该 revision 作为 `expected_revision`。这些是记录回执，不替代 checkpoint、Git、Review 或 Acceptance 原始证据；记录失败或冲突时保存真实错误与待协调状态，不预填成功 revision。

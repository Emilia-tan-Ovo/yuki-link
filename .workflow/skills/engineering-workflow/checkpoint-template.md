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
work_item:
  id: "<编排 work_item 稳定标识，不是 runtime ID>"
  revision: null
  purpose: null
  subject_ref: null
  scope_ref: null
  authority_ref: null
  cycle_id: null
  related_work_item_ids: []
  issue_set_refs: []
  runtime_work_item_id: null
  generation: null
  generation_state: null
  session_id: null
  operation_id: null
  journal_ref: null
  observed_state: null
  continuation_ref: null
  replacement_decision_ref: null
  reconciliation_ref: null
related_work_items: []
# 未完成关联项每项保存：id、purpose、cycle_id、related_work_item_ids、
# issue_set_refs、observed_state、runtime_work_item_id、generation、
# generation_state、session_id、revision、evidence_ref；runtime 未提供的字段为 null。
focused_review_budget:
  cycle_id: null
  repair_work_item_id: null
  reviewer_work_item_id: null
  owner: null
  allowance: null
  consumed_rounds: null
  authorization_ref: null
  additional_authorization_refs: []
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
- 按所选同根 engineering-workflow/SKILL.md 的“工作项生命周期”记录 current work item 及所有未完成 related work items；复制模板后仍通过 Skill 根定位规范。编排 id 在交接后保持稳定，runtime_work_item_id/session_id 等只有真实回执才填，不编造运行时支持。
- repair 与 focused reviewer 以 cycle_id 和双向 related_work_item_ids 关联，各自保留 state、generation 及 issue set 引用；切换 current work item 不删除仍未完成的另一项。复核预算记录责任 owner、获准 allowance、已消费轮次及追加授权引用；未知不是零，也不是无限预算。
- 证据引用、观察时间、来源、结果和适用的内容身份。Git 是 branch/HEAD/diff 的 source of truth。
- test/review/acceptance 要记录 fixed point、受检 commit；若有未提交内容，附 tracked diff 和相关 untracked 文件字节摘要。仅 HEAD 不足以覆盖脏工作区。
- Review 的两轴结论、原 finding、修复检查及 reviewer 隔离证据；命令退出码与精简报告路径。
- runtime adapter 提供的 session/run 是观察值，附查询入口与最近状态；未提供该能力时标记不适用，不编造 ID。
- 每个模型 run 终态后，用 runtime adapter 的 durable run status 累加 `model_usage` 的 input/cached/output 与 run 数；这些数字只作工程成本诊断，不等同于产品 quota。启动下一次模型 run 前必须先检查 anomaly 状态和最近一次成本说明。

# Issue set / 待处理问题
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

runtime adapter 支持工作流记录时，保存最近成功回执的 revision、查询引用与观察时间。提交后续状态以该 revision 核对并发变化；冲突时先协调。这些是记录回执，不替代 Git、Review 或 Acceptance 原始证据；未提供该能力时保持 null。

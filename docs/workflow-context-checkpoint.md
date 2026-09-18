# Workflow Context Checkpoint（v1.1）

活跃执行状态位于当前 worktree 的 `.local/workflow-state/<ticket>.md`，不进 Git。正式 schema、边界写入条件与恢复行为随 `engineering-workflow` 安装包一起版本化：

- [公共入口与阶段路由](../.workflow/skills/engineering-workflow/SKILL.md)
- [YAML Front Matter + Markdown Body 模板](../.workflow/skills/engineering-workflow/checkpoint-template.md)
- [恢复顺序、动态事实核验与 external interruption](../.workflow/skills/engineering-workflow/recovery.md)

稳定工程规则在 AGENTS，领域语言在 CONTEXT，架构决定在 ADR，产品要求在 Spec/Ticket，实现决定在 Implementation Notes。checkpoint 只作导航；Git、YCA、测试及 runtime 才是动态事实来源。完成后的长期 archive 属于 WORKFLOW-005，原始日志始终留本机。

本票的 source/fixture 验证见 [WORKFLOW-003 验收说明](../tools/workflow-skills/fixtures/README.md)。这不表示用户全局 Skill 已应用或当前会话已重新加载；真实 protected apply 仍须 Owner 对具体 preview/diff 明确批准。

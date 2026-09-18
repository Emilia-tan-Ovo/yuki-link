# Workflow Context Checkpoint（v1.1 草稿）

> 目的：让 Emilia / Sylvia 在 fresh session、聊天上下文压缩或长任务中断后，依靠外部状态恢复，而不是依赖模型记忆。

## 状态分层

| 信息 | Source of truth | 是否动态 |
| --- | --- | --- |
| 工程规则 | AGENTS.md | 低 |
| 领域语言 | CONTEXT.md | 低 |
| 难以逆转的架构决定 | ADR | 低 |
| 产品需求 | Spec / Ticket | 中 |
| 实现级已确认决定 | Ticket Implementation Notes | 中 |
| 当前执行状态 | .local/workflow-state/<ticket>.md | 高 |
| 原始运行证据 | YCA runtime / Git / tests | 高 |
| 完成后的长期摘要 | closeout archive | 冻结 |

## Checkpoint 最小模板

```markdown
# <ticket> workflow checkpoint

phase: ticket-design | implementation | review | fix | acceptance | closeout
updated_at: <timestamp>

## Git
worktree:
branch:
fixed_point:
head:

## Sessions
implementation_session:
implementation_runs:
review_sessions:
acceptance_runs:

## Confirmed decisions
- 只写已确认、恢复工作必须知道的决定。

## Current evidence
- 最近一次测试 / diff / tool event / resident 验收事实。

## Open findings / blockers
- finding:
  status:
  evidence:

## Next action
- 一条可直接执行的下一步。
```

## 写入时机

只在阶段边界和真正改变恢复路径的事件更新：

1. ticket-design 完成 → implementation；
2. implementation 完成 / commit → review；
3. review 产生 finding；
4. finding 修复 → focused re-review；
5. review cleared → acceptance；
6. acceptance cleared → closeout；
7. 中断/异常会导致 fresh session 不知道怎么继续时。

不把每一条命令、模型思考过程或完整日志复制进去。

## 恢复协议

fresh Emilia/Sylvia session 恢复一张票时：

1. 读取完整 Ticket；
2. 读取 source Spec；
3. 读取 CONTEXT/ADR/适用 AGENTS；
4. 读取 Implementation Notes；
5. 读取 workflow checkpoint；
6. 用 Git/YCA 验证 checkpoint 中最重要的动态状态仍然成立；
7. 从 `Next action` 继续。

Checkpoint 是导航，不是最终事实；动态事实仍以 Git/YCA/runtime 为 source of truth。

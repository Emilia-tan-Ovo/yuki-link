# 005 — 自动生成可追溯的 closeout archive

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 在 ticket 完成时自动生成轻量、可版本化、可供 fresh Agent 恢复历史的 closeout 摘要，同时保留对本机原始 evidence 的追溯，不把大型 runtime 日志提交 Git。

**Blocked by:** 003 — 打通 engineering-workflow 与 checkpoint 恢复闭环.

**Risk hint:** normal

**Status:** ready-for-agent

## Acceptance criteria

- [ ] closeout archive 进入版本控制并形成稳定、可读的长期摘要。
- [ ] 至少记录 Ticket/Issue、branch/worktree、implementation/review/acceptance session/run、模型/reasoning、代表性耗时/调用、失败/重试、findings 与修复、PR/merge、人工介入点和 raw evidence 位置。
- [ ] 原始 JSONL、大型测试输出和 runtime 日志不会被复制进 Git。
- [ ] 对缺失/已过期的本机 raw evidence 能明确标记，而不是伪造长期可用性。
- [ ] 自动化生成结果可重复核对，并允许 Emilia 在提交前做人类可读的 evidence consistency 检查。
- [ ] fresh clone 仅凭 Git 中的 archive 可以理解“这张票发生了什么”，但不会把 archive 当成动态 runtime source of truth。

## Implementation-design boundary

具体使用 Skill、repo-local script、CLI 或其他实现由 ticket-design 决定。

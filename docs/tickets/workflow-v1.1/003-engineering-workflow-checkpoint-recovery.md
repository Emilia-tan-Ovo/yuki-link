# 003 — 打通 engineering-workflow 与 checkpoint 恢复闭环

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 从已确认 Design Handoff / Spec / Ticket 进入统一 `engineering-workflow`，正确识别 phase、调用现有领域 Skills、在阶段边界保存 checkpoint，并让 fresh session 仅依靠持久化产物恢复后继续工作。

**Blocked by:** 002 — 建立 Workflow Skill 来源与安全应用边界.

**Risk hint:** high

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `engineering-workflow` 可以识别 discovery/spec/tickets/ticket-design/implementation/review/acceptance/closeout 等阶段并路由到正确 Skill。
- [ ] `pair-with-docs`、`to-spec`、`to-tickets`、`ticket-design` 形成足够恢复的 handoff，而不依赖完整聊天仍在上下文。
- [ ] ticket-design 调查后没有高杠杆未决问题时，可以直接形成 Implementation Notes，不制造用户问题。
- [ ] checkpoint 使用 YAML Front Matter + Markdown Body，并保存在 repo-local 非 Git 的 workflow-state。
- [ ] checkpoint 只在阶段边界、finding 状态变化或恢复路径变化时更新，不成为逐命令日志。
- [ ] fresh session 按 Ticket → Spec → CONTEXT/ADR/AGENTS → Implementation Notes → checkpoint 的顺序恢复。
- [ ] fresh session 会重新验证 Git/YCA/tests/runtime 等动态事实，而不是盲信 checkpoint。
- [ ] ticket-design → implementation 默认可连续；上下文异常膨胀时可以通过 handoff/checkpoint 安全切 fresh implementation session。
- [ ] fixture 验收证明上下文清空后仍可从 checkpoint 的 Next action 继续。

## Implementation-design boundary

checkpoint 的具体字段 schema、workflow router 内部组织方式由 ticket-design 决定，但不得改变已确认的信息分层与恢复协议。

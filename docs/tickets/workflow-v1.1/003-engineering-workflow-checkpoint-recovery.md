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
- [ ] ChatGPT 审查、客户端断连、网络中断或对话切换等 external interruption 不会被误报成项目/YCA/Codex 失败；恢复后先验证动态事实，再继续正确 phase。
- [ ] implementation 被人为中断后可以复用原 session 或通过 Implementation Notes + checkpoint 切 fresh session，且不会重复已完成副作用。
- [ ] review/acceptance 边界中断后，不重复已经有充分证据完成的 full review。

## Implementation-design boundary

checkpoint 的具体字段 schema、workflow router 内部组织方式由 ticket-design 决定，但不得改变已确认的信息分层与恢复协议。

## Implementation Notes

- 依已确认 Spec/决策完成调查，implementation frontier 为空；本轮 Owner 已授权设计后直接实现。采用 Skill 编排与随包模板/恢复协议，不新增 YCA API、运行时服务或状态数据库。
- checkpoint schema v1 使用 YAML Front Matter + Markdown Body，保存在当前 worktree 的 `.local/workflow-state/<ticket>.md`；机器字段记录阶段、Git 身份、session/run 引用和更新时间，正文记录决定、证据、finding、副作用与下一步。未知值显式为空，不能推断成功。
- 阶段由持久化产物及重新验证的证据共同确定；恢复顺序保持 Ticket → Spec → CONTEXT/ADR/AGENTS → Implementation Notes → checkpoint。Review/test 证据绑定受审内容及环境；失效只重做受影响检查。未知副作用先调查，禁止盲重放。
- 独立调用设计 Skills 保留设计边界；明确授权的上层 workflow 可连续推进。WORKFLOW-003 不改 implement/code-review/review-change 的内部语义：004 未交付时首次 review 复用现有完整双轴入口，已有充分证据的 review 不重跑；closeout 自动化留给 005。
- 主验收在隔离 fixture 仓库通过 engineering-workflow 公共 Skill 入口运行 fresh agent，只传持久化文件引用，覆盖人为中断、过期动态状态、已完成副作用和 review/acceptance 恢复。确定性检查只核对外部产物，不断言提示词措辞。安装兼容性沿用 WORKFLOW-002 公共 CLI / MCP protection seam。
- 实现顺序：checkpoint/路由 → 四个设计阶段 handoff → fixture 恢复与安装回归 → fresh 双轴审查及定向修复 → 本地验收。字段命名与 fixture 文件布局按上述边界在实现中决定。

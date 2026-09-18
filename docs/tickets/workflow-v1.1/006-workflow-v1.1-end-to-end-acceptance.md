# 006 — Workflow v1.1 端到端验收与正式启用

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 用已确认 primary acceptance seam 真实跑通 Workflow v1.1，并在证据充分后正式启用，不把“若干单点能力分别可用”误写成整套工作流已稳定。

**Blocked by:** 001、003、004、005.

**Risk hint:** high

**Status:** ready-for-agent

## Acceptance criteria

- [ ] 在临时 fixture 仓库从 Design Handoff / Spec / Ticket 启动 `engineering-workflow`。
- [ ] ticket-design → implementation 按规则保留连续上下文。
- [ ] full Review 使用 fresh reviewer。
- [ ] 人为构造 finding 后，修复进入 fresh focused re-review。
- [ ] docs-only / closeout 进入 evidence Review，且更高风险可升级。
- [ ] checkpoint 在正确边界更新，动态事实会重新验证。
- [ ] acceptance 使用 filesystem/Git/command/test/YCA events 等 ground truth，而不是模型自述。
- [ ] closeout archive 正确生成且不复制大型 raw logs。
- [ ] 新开完全 fresh session 后，仅凭持久化产物可以恢复并继续正确 next action。
- [ ] Codex 等待期间 observation wait 不会终止仍在推进的 run，且重复轮询显著减少。
- [ ] 单独调用 `implement` 的兼容行为仍成立。
- [ ] 最终能力说明明确区分 implemented / accepted / stable；本票通过只证明真实链路验收，不自动宣称长期稳定。

# 004 — 实现分级 Review 与 implement 向后兼容

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 增加 `review-change` 路由，让 full/focused/evidence 三种 Review 依据实际风险工作，同时保持现有完整 `code-review` 双轴语义和单独调用 `implement` 的旧行为。

**Blocked by:** 002 — 建立 Workflow Skill 来源与安全应用边界.

**Risk hint:** high

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `full` 使用 fresh reviewer，并调用现有 Standards + Spec 双轴 `code-review`。
- [ ] `focused` 只围绕具体 finding/风险、相关 diff、fixed point 和必要规范。
- [ ] finding 修复后的 re-review 默认 fresh，不重新运行整票 full review。
- [ ] `evidence` 可以处理 docs-only、acceptance 记录与 closeout 的 diff/evidence consistency。
- [ ] evidence/focused 遇到生产行为变化、规范冲突或更高风险时可以升级；明显高风险变更不可为了成本降级。
- [ ] implementation session 历史不作为 reviewer 的隐式证据。
- [ ] workflow policy 存在时，`implement` 产生 Implementation Handoff 并把 Review 选择交给 `review-change`。
- [ ] 单独调用 `implement` 时仍默认执行完整 `code-review`，保持向后兼容。
- [ ] 完整 `code-review` 的 Standards / Spec 两轴语义不被改变。

## Implementation-design boundary

风险判定的具体内部表示和路由实现由 ticket-design 决定；初始 risk hint 只能辅助，最终以实际 diff/风险为准。

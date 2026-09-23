---
name: ticket-design
description: Pair with the user on the implementation-level design needed to make one already-scoped ticket ready for /implement.
disable-model-invocation: true
---

# Ticket Design

Prepare exactly one current ticket for implementation. Treat its accepted product behavior and scope as fixed; resolve only the high-leverage question, "How should this ticket be implemented?"

This is the checkpoint in `to-tickets -> ticket-design -> implement`. Stay in design: inspect and discuss, but create no business code, start no refactor, expand no ticket scope, and never invoke `/implement` automatically.

## 1. Establish the implementation context

Read progressively, in this order:

1. The complete current ticket and any already-persisted notes for this ticket.
2. Every applicable `AGENTS.md` plus the stable project conventions/invariants needed to interpret the ticket.
3. The relevant sections of its source Spec. Expand to the full relevant Spec when the ticket boundary, contract, or acceptance semantics remain uncertain.
4. `CONTEXT.md` / ADR entries named by the ticket/Spec or required by an unresolved implementation decision; do not load unrelated history by default.
5. The current code, configuration, tests, Git state, and nearby implementation precedents. For large sources, prefer the relevant symbol / section / line range once the implementation area is located.

Historical Tickets, prior Review/Acceptance/closeout records, `.workflow/history`, README indexes, complete large Specs, and full Memory are **cold by default, not forbidden**. Search/retrieve first and open the relevant slice; read the complete source whenever the retrieved evidence is insufficient or a correctness-sensitive decision depends on broader context. Context planning is a starting map, not a hard allowlist; correctness takes priority over context budget.

Resolve facts available from those sources or tools yourself. Ask the user only for information that cannot be discovered and would materially change the design. If the ticket conflicts with the spec or current code, surface the conflict rather than silently redefining scope.

Completion criterion: the ticket boundary, applicable constraints, and existing implementation shape are evidenced well enough to identify the real implementation decisions.

## 2. Build and work the implementation frontier

List only unresolved decisions that materially affect one or more of:

- data semantics, integrity, schema constraints, relationships, or important indexes;
- an external interface contract, including URL, method, request, response, and meaningful error semantics;
- security, consistency, or integration with an external system or existing capability;
- module responsibilities, interface shape, seam placement, or adapter choice;
- pre-agreed test seams and the critical behavior to verify.

Not every ticket needs every category. Exclude routine DTO, method, and variable names; conventional framework mechanics; and low-risk local details the agent can follow from project precedent.

Choose the highest-leverage decision whose prerequisites are settled. Discuss one decision at a time, incorporate the result, then recompute the frontier. Use the `codebase-design` vocabulary when module interfaces or seams are genuinely at issue.

## 3. Pair on each decision

When the user can reasonably judge the decision, first invite their intuition or rough design. Review that draft: identify strengths, risks, missing boundaries, and trade-offs, then refine it together into an agreed decision. Do not front-load an exhaustive option set that reduces the user to approving a finished design.

When the user explicitly loses track of the layers, cannot connect the concepts, or says they do not understand, pause the current decision and show a brief, ticket-specific implementation map. Prefer familiar backend layers such as `HTTP / Controller -> Service -> Repository -> Database -> Integration Test`, but include only layers relevant to the ticket. Mark the layer or seam under discussion, affected layers, decisions already settled, and the approximate next layer. Use the map only for reorientation; once understanding returns, resume the same decision without reopening the frontier or adding questions.

When the decision depends on unfamiliar technical knowledge, begin with a concrete example from the current ticket and, when reorientation was needed, its current layer map. Introduce the abstract term and alternatives only after that grounding:

1. Explain the concept in plain language.
2. Present the main viable approaches and important trade-offs.
3. Give a recommendation and reasons when one approach is clearly preferable.
4. Invite an informed decision or confirmation.

If the user remains stuck or says they do not know, teach the missing concept or recommend a reasonable path directly; do not turn the exchange into a guessing exercise.

Label every new agent-originated behavior rule, constraint, data design, interface design, or architecture choice as a **Proposal** until the user confirms it. A recommendation is not an agreed decision.

## 4. Prune at the implementation frontier

Regularly ask whether the remaining uncertainty can change the implementation direction. Stop exploring when the relevant data design, external contract, key implementation boundaries, integrations, and test seams are clear enough for `/implement` to proceed safely.

Summarize low-risk unresolved details as deferred to `/implement` under project conventions. Do not exhaust edge cases or reopen product requirements already settled by the spec and ticket.

Completion criterion: every frontier item is either an agreed implementation decision or an explicitly deferred low-risk detail.

## 5. Confirm and persist the design

Summarize:

- the agreed Implementation Decisions;
- a short implementation sequence;
- the few deferred implementation details, if any;
- a short **Context Plan** for the fresh implementation session.

Ask the user to confirm shared understanding. After confirmation, inspect the current tracker format and how `/implement` reads tickets. If an extra Markdown section is compatible, add or update this section in the current ticket:

例外：调查后 implementation frontier 为空、决定均已由 Spec/ADR/Ticket 或本轮授权解决时，直接形成 Implementation Notes 并声明 ready；不制造用户问题或重复确认。只有真正新的高杠杆提案才需要 Owner 确认。实现顺序和低风险命名细节可按既有约定决定，不能借此扩大范围。

```markdown
## Implementation Notes

- <only decision-rich data, interface, module/seam, integration, or test notes>

### Context Plan

- **Core:** <current Ticket/AC, invariants, direct code/test entry points>
- **Related:** <relevant Spec/Ticket/interface/source and why>
- **Retrieval:** <cold references and search symbols>
- **Expansion triggers:** <risk signals requiring broader investigation>
```

Generate the four machine labels with `node tools/codex-session-bridge/scripts/validate-context-plan.mjs --template`; keep their ASCII punctuation and English keys exactly. After writing the Notes, run `node tools/codex-session-bridge/scripts/validate-context-plan.mjs <absolute-notes-path>`. Handoff requires `CONTEXT_PLAN_OBSERVED`; fix malformed, empty or duplicate labels before declaring ready. This command uses the same `markdown-context-v0` adapter as Context Packet reads.

Keep the notes concise. Record decisions, not the conversation; include no substantial implementation code and do not repeat requirements already present in the spec. Preserve the ticket's existing structure and all unrelated content.

真实 tracker 是当前票据时把 Notes 写入该 Issue；仓库有对应本地票据则同步同一 Notes。更新前读取最新内容，保留他人变更；如果本轮禁止外部写入，保存本地 Notes 并明确 tracker 待同步。上层 workflow 在交接时保存 checkpoint：worktree、branch、fixed point、HEAD、Notes 引用、deferred details 与 Next action。独立调用时 Notes 本身也必须足够 fresh implementation session 理解，不依赖本次聊天。

如果 tracker 或票据格式不能安全承载 `## Implementation Notes`，保持其结构，将简短 Implementation Summary 持久化到仓库已有 Notes 位置；没有约定时使用 `docs/implementation-notes/<ticket>.md`。文件必须包含原 Ticket/Spec 引用、实现决定和 deferred details；交接及 checkpoint 引用实际路径。仅在文件写入并回读验证后才能宣布 ready，不能只将摘要留在聊天中。fresh session 的 Implementation Notes 步骤读取该替代文件。

## 6. Hand off

在共享理解已确认（或 frontier 为空且决定已有确认来源），并且内嵌 Notes 或替代 Notes 已持久化且回读验证后，才声明如下 ready 状态。写入失败或本轮不允许写入时，报告具体未完成的持久化动作，不宣布 ready：

> The current ticket is ready for implementation.

Recommend `/implement <current-ticket>`. Invoke it only when the user explicitly asks.
显式授权可以来自本轮 engineering-workflow 的“设计后继续实现”；此时完成本 Skill 后返回上层继续，无需再次请求同一授权。没有实现授权时仍停在设计交接。**ticket-design model session 到此默认结束；implementation 必须从已持久化的 Implementation Notes + checkpoint + fixed point 启动 fresh session。** 不把本次设计聊天复制给 implementation。只有 Owner 明确批准 session continuity 例外、且上层确认继续复用确有必要、不会造成上下文异常膨胀时才可复用。

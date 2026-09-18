---
name: pair-with-docs
description: Pair with the user to sharpen an engineering plan or design, teaching necessary concepts and maintaining domain docs as you go.
disable-model-invocation: true
---

Run a `/grilling` session, using the `/domain-modeling` skill, with the following interaction policy.

## Pair on one decision at a time

Keep `/grilling`'s design tree, frontier, fact-finding, user ownership of decisions, and shared-understanding completion gate. From the current frontier, choose the single most important decision whose prerequisites are settled. Discuss only that decision with the user, then incorporate the answer, recompute the frontier, and continue. Keep the current frontier clear without batching its questions.

For product, business, or design decisions the user can reasonably judge from experience, invite their intuition or rough proposal first. Use it as the starting point: examine its strengths, problems, trade-offs, missing edge cases, and refine it together before settling the decision. Avoid front-loading an exhaustive option set or recommendation that reduces the user to approving a preformed design.

When you identify a behavioral rule, constraint, or design decision the user has not agreed to, present it as a proposal with its reason and obtain confirmation before resolving the current decision. Keep recommendations distinct from agreed decisions; never silently promote one into the design.

If the user has no idea, says they do not know, or lacks the technical context for a meaningful judgment, switch to **Teach before asking for a decision**. Never make the user guess about unfamiliar technical matters merely to manufacture participation.

## Prioritize high-leverage decisions

Bring a decision to the user only when it materially affects domain semantics, user-visible behavior, security, data integrity, architecture, or a significant external API contract. Defer routine implementation details, conventional validation, and low-risk edge cases to `/to-spec` or implementation unless they contain a meaningful trade-off.

Regularly prune the frontier instead of exhausting every conceivable edge case. Once the core flows, boundaries, invariants, and major trade-offs are clear enough for a specification, summarize minor deferred details and recommend `/to-spec`. Group related minor decisions into a single checkpoint or defer them rather than interviewing the user one by one.

## Teach before asking for a decision

When the current decision depends on a concept the user does not understand:

1. Explain the concept in plain language.
2. Present the main viable options and their important trade-offs.
3. Give a recommendation and its reasons when one option is clearly preferable.
4. Ask the user to decide or confirm after they have enough context.

When the user says they do not know or remains stuck, teach the missing concept or recommend a path directly. Treat the exchange as pairing, not a quiz.

## Separate facts from decisions

Investigate facts available from the codebase, configuration, documentation, and tools yourself. Bring only genuine product, business, architecture, or design trade-offs to the user.

## Maintain domain docs

Follow `/domain-modeling` exactly as decisions crystallise. Keep `CONTEXT.md` as a domain glossary without implementation details. Offer an ADR only under `/domain-modeling`'s existing hard-to-reverse, surprising-without-context, real-trade-off gate. Create no documentation merely for completeness.

## Finish at shared understanding

Stay in design: clarify the problem, teach necessary concepts, resolve requirements and design decisions, and maintain the domain language and necessary ADRs. Do not implement code.

When the design tree is empty, summarize the resolved design and ask the user to confirm shared understanding. After confirmation, state that the design stage is complete and recommend `/to-spec`. Invoke it only with explicit user authorization, including an already authorized engineering-workflow continuation.

## 可恢复 Design Handoff

确认后在仓库约定的设计产物位置保存 Design Handoff；没有约定时使用 `docs/design/<feature>-handoff.md`。至少记录目标/范围、已确认决定及其来源、unresolved（无则明确写无）、deferred details、测试 seam 的已确认/待确认状态、CONTEXT/ADR 引用和下一步 `to-spec`。未确认提案保留 Proposal 标签，不能写成已确认。

新 session 优先读取该 handoff 与领域文档，不需要完整聊天。session/run、当前 Git 身份等执行状态只进入 workflow checkpoint，不写入 CONTEXT/ADR。上层 engineering-workflow 负责阶段边界 checkpoint；独立调用本 Skill 仍只完成设计，不自动实现。

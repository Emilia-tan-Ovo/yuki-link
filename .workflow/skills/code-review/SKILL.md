---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both axes in one fresh reviewer sequentially by default and reports them side by side; parallel reviewers require explicit Owner approval for a second model line. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

Two-axis review of changes since a supplied fixed point, including the ticket's uncommitted work:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?

By default, one **fresh reviewer** runs Standards → Spec sequentially over the same pinned subject and keeps the two reports separate. Do not create parallel review sub-agents unless the Owner has explicitly approved a second active model line for this review.

Use the supplied Ticket/Spec and tracker workflow when available. A supplied local ticket/Notes is sufficient; a missing tracker config does not require installing setup tools or publishing anything.

## Process

### 1. Pin the fixed point

Use the fixed point supplied by the user or explicit implementation handoff — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. Resolve it to a SHA. If none is discoverable, ask for it rather than guessing a baseline.

Read [the review subject protocol](review-subject.md). Capture committed changes from the resolved merge-base through HEAD **plus staged, unstaged and relevant untracked content**, with hashes. Also capture `git log <fixed-point>..HEAD --oneline`. Both axes receive the same explicit subject; `git diff <fixed-point>...HEAD` alone cannot review a pre-commit implementation.

Invalid refs or incomplete evidence stop here. Only when every included layer is empty report no-change, before spawning empty reviews. Preserve unrelated work and list scope exclusions.

The review coordinator must be fresh relative to implementation. A caller with implementation history prepares only the evidence package and dispatches a fresh coordinator, explicitly with no history inheritance (`fork_turns: "none"` or equivalent). An already fresh coordinator proceeds directly. Record actual session/creation evidence; unavailable isolation means incomplete, not self-review.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via the supplied tracker workflow; preserve authoritative local Implementation Notes when the tracker mirror is stale.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, skip the **Spec** axis and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Execute both axes in one fresh reviewer by default

The fresh reviewer executes **Standards first, then Spec**, over the same pinned subject and evidence package. Keep the axes logically independent: do not let a Standards conclusion replace Spec checking or vice versa, and persist the two reports separately. This sequential default is the normal cost-safe path.

Only when the Owner has explicitly approved a second active model line for this review may the coordinator create separate axis sub-agents. In that exception, create them without inherited implementation conversation (`fork_turns: "none"` or equivalent), give both the same pinned subject/content identity, and record the real session/creation evidence.

**Standards axis brief** — include:

- The complete pinned subject, all included diff commands/new file references and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec axis brief** — include:

- The same complete pinned subject, diff commands/new file references and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

Before declaring completion, revalidate the subject under the protocol; drift makes the affected review evidence stale. Persist the subject/report references, standards/spec identity, isolation evidence and open findings for the caller. A missing axis is incomplete (except an explicitly absent Spec as above). Return findings for implementation; when only those findings are fixed, the caller uses same-root review-change for fresh focused re-review, retaining these two separate axis reports. This Skill never performs the fix or commits for the reviewer.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

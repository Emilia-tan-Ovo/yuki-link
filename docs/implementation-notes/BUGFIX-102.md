# BUGFIX-102 Implementation Notes

## Goal

让 `harness_record_workflow` 在保持现有 `INVALID_WORKFLOW_RECORD` 兼容外壳的前提下，对 schema/path validation 失败返回有界、可操作、可稳定测试的结构化 diagnostics，避免 Orchestrator 只能靠试错猜具体字段与原因。

## Acceptance

- 保留 `INVALID_WORKFLOW_RECORD` 错误码与现有 `error.details` 外壳。
- Zod schema 失败返回有界 `{ field, path, reason }` issues。
- artifact/subject path 校验返回稳定 reason code 与具体元素路径。
- diagnostics 不回显敏感字段值、凭据、绝对路径原文或巨大 schema 对象。
- validation 失败不增加 Workflow revision，不写 Journal。
- public MCP 测试覆盖 schema/path 错误，以及既有成功/幂等回执不回归。

## Context Plan

- **Core:** `harness_record_workflow` public MCP seam、Workflow input schema/validation、WorkflowSource.validate、错误映射、对应测试。
- **Related:** Harness workflow journal/revision 语义、public MCP response compatibility。
- **Retrieval:** GitHub #102、仓库 AGENTS/engineering-workflow、现有 workflow validation tests、#101/#93 已合并后的最新基线。
- **Expansion triggers:** 仅当现有错误映射或 path validator 的共享抽象要求跨文件修改时扩展；不得顺手实现 #103/#104 或既存 set-cookie 测试问题。

## Constraints

- 基线：`0c9ddf07e3ed1d72f10418d89632ed35c2d01ae3`。
- 分支：`codex/bugfix-102-validation-diagnostics`。
- 维持 fail-closed；diagnostics 只增加可操作信息，不改变 validation 是否通过的结论。
- 错误信息必须有界且脱敏。
- commit 使用中文。
- Implementation Handoff 在实现完成后追加到本文件。

## Implementation Handoff

- **来源与身份：** GitHub #102；当前 worktree `bugfix-102`，分支 `codex/bugfix-102-validation-diagnostics`，fixed point / 开始时 HEAD 为 `0c9ddf07e3ed1d72f10418d89632ed35c2d01ae3`。本 Notes 是开始时唯一未跟踪文件；其余实现文件开始时无改动。
- **修改：** `harness_record_workflow` 的公开入口将原始参数交给记录层校验，错误仍以 `INVALID_WORKFLOW_RECORD`、`error.message` 和 `error.details` 返回。Zod 错误最多返回 8 项 `{field,path,reason}`，关系约束使用固定路径和 reason code；路径验证最多返回 8 项，明确指向 `snapshot.artifacts[i].location` 或 `snapshot.subject.<kind>[i].path`。诊断不包含原始值、绝对路径或 Zod message。验证仍在 revision 和 Journal 写入前完成。
- **测试：** `node --test --test-name-pattern="公开 MCP Workflow validation" test/harness-workflow.test.ts`：1 passed；覆盖 schema 缺项、字段格式、关系约束、artifact/subject path、脱敏与限量、失败不写 Journal/不加 revision、成功与幂等回执。`node --test test/harness-execution-gate.test.ts`：10 passed。`npm run typecheck`：exit 0。`git diff --check`：exit 0。
- **已知边界：** `node --test --test-force-exit test/harness-workflow.test.ts`：新增 1 passed，既存 10 failed；这 10 项都在原 fixture 读取 `set-cookie` 的 `.split()` 处因 header 为 null 而中止，未进入各自断言。本票没有修改该 fixture。未执行真实 Orchestrator 调用或日常使用验收。
- **Review 与提交：** 本次实现未执行独立 Review，状态为 pending；本 Notes 与实现同次提交，精确 commit 以提交后的 `git rev-parse HEAD` 为准。未 push、未建 PR、未合并。
- **下一步：** 由后续 fresh Review 对照 #102 和本提交检查 Standards / Spec，再按当前证据验收；`set-cookie` 夹具问题另票处理。

# ISSUE-151 Implementation Notes

- Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/151
- 范围溯源：`card:e593ce3f-8b74-4e66-9684-6c73a9d336fb:2`。
- 设计基线：`094b049cc733e0891af262a721370cb203c79260`；目标分支：`main`。

## Acceptance Evidence Plan
```json
{
  "schema_version": 1,
  "issue_ref": "https://github.com/Emilia-tan-Ovo/yuki-link/issues/151",
  "criteria_sha256": "52f74a712d57356e2fa4a14c56a99ecbd64100a8109c6f4617893c71709e12b4",
  "criteria": [
    {
      "criteria_ref": "AC1",
      "text": "docs/acceptance/companion-007-representative-e2e.md 存在，并包含上述标题与英文说明。",
      "source_kind": "review"
    },
    {
      "criteria_ref": "AC2",
      "text": "本 Ticket 的最终 Git subject 只包含该 E2E 文档与 docs/implementation-notes/ISSUE-<本Issue号>.md；流程产生的 .local ignored 证据不计入 Git。",
      "source_kind": "git-subject"
    },
    {
      "criteria_ref": "AC3",
      "text": "最终受检 subject 已完成 fresh Review，且 Review 结论通过。",
      "source_kind": "review"
    }
  ]
}
```

摘要算法：按 Issue checklist 顺序，仅保留每项的 `criteria_ref`、`text`（字段顺序同前），序列化为紧凑 JSON 数组，以 UTF-8 无 BOM、无末尾换行的字节计算 SHA-256。以上为候选证据计划，不表示 AC 已通过。

## Implementation Notes

- 当前 Issue 已确定文件路径、必要正文和三条证据来源；implementation frontier 为空，无新增产品或架构决策。
- 后续实现新增 `docs/acceptance/companion-007-representative-e2e.md`，正文保留 Issue 指定的标题 `# COMPANION-007 Representative E2E` 与英文说明 `This file exists only to verify the confirmed-to-PR companion workflow.`，按普通 Markdown 排版。
- 最终 Git subject 恰好包含该 E2E 文档与本文件 `docs/implementation-notes/ISSUE-151.md`。报告、运行身份、checkpoint 与审查证据放在 ignored `.local/`，不进入 Git。
- 仅文档变更，不新增业务代码、测试 fixture 或依赖。AC1 检查最终文件正文；AC2 检查最终完整 Git subject 文件集合及忽略规则；AC3 要求独立 fresh Review 通过且绑定同一最终 subject。内容变化后，旧 Review 不代表新 subject 已通过。
- 本轮仅设计；后续 implementation 使用 fresh session，从 Ticket、本 Notes 与 checkpoint 恢复，并重新核对基线。Review 与外部交付由后续阶段授权控制，不在本轮启动；禁止 merge、deploy。

### 实现顺序与延后细节

1. 复核 Issue checklist、Git 基线和已有改动归属。
2. 新增指定文档，核对正文及两文件范围。
3. 将最终 subject 交 fresh Review；通过后由上层按当时授权推进验收与 PR。

延后细节：仅空行、末尾换行等普通 Markdown 排版，无待确认高杠杆决策。此票没有业务测试入口；验收入口为两个文档与 Git subject，不新增测试文件。

### Context Plan

- **Core:** https://github.com/Emilia-tan-Ovo/yuki-link/issues/151；`AGENTS.md`；`docs/implementation-notes/ISSUE-151.md`；待创建的 `docs/acceptance/companion-007-representative-e2e.md`；`.local/workflow-state/ISSUE-151.md`；固定基线 `094b049cc733e0891af262a721370cb203c79260`。
- **Related:** `.gitignore` 的 `.local/` 规则；`.workflow/skills/implement/SKILL.md` 的 fresh session 与交接约定；`.workflow/skills/code-review/review-subject.md` 的完整受检 subject 定义。当前 Ticket 是直接需求来源，无须加载其他 COMPANION 功能 Spec。
- **Retrieval:** 只在验收证据或 subject 定义不清时读取 `.workflow/skills/code-review/SKILL.md` 和 `.workflow/skills/review-change/SKILL.md`；Context Plan 格式检查入口为 `tools/codex-session-bridge/scripts/validate-context-plan.mjs`。
- **Expansion triggers:** Issue checklist 改变、基线漂移、出现非本票改动、Git subject 超出两文件或最终字节与 Review 绑定不一致时，暂停相应交付并核实；不扩展为 Companion 功能实现或额外 E2E 矩阵。

## 设计交接

本地 canonical Notes 已承载设计；当前阶段无外部写入授权，GitHub Issue Notes 待上层按授权同步。设计就绪不等于实现、Review 或验收完成。

## Implementation Handoff

- 来源：Issue #151 与本文件的 Implementation Notes；fixed point/当前 HEAD 均为 `094b049cc733e0891af262a721370cb203c79260`，工作分支为 `codex/prep-179cadbf-20be-4343-9b00-73633d288b9d`。
- 范围：新增 `docs/acceptance/companion-007-representative-e2e.md`，包含指定标题与英文说明。该文档 SHA-256 为 `7b3fa526a60c00db4296c36ac50d5ccae2e48a1d46094392551d7ea8f8014980`；本 Notes 记录设计与实现交接。
- 定向验证：PowerShell 7 核对文档完整正文、UTF-8 无 BOM、Git 非忽略文件集合恰好为上述两文件、`.local/` 忽略规则，以及 `git diff --check` / `git diff --cached --check`，均通过。纯文档变更，业务测试与 typecheck 不适用；完整测试套件由上层决定。
- Review policy：`delegated`，接收方为 Ticket Main；fresh Review 尚未执行，finding 状态未知，AC3 未通过。
- Git 状态：两文件目前均未跟踪；本轮按上层明确分工不执行 commit、push 或 PR。最终 Git subject 与 Review 的内容绑定须由上层在提交前后复核。
- 下一步：Ticket Main 将这两个文件的最终内容交给 fresh Review；通过后再核对验收与外部交付。实现报告和结果 JSON 位于本票 ignored `.local/workflow-artifacts/companion/` 目录。

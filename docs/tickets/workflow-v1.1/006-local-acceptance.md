# WORKFLOW-006 端到端验收记录

## 结论

2026-09-19，WORKFLOW-006 / GitHub #28 的 13 条 Acceptance Criteria 均以真实 Git、文件、命令、测试、YCA durable events 与隔离 Reviewer 证据核对为 **PASS**。

本记录只证明当前 Workflow v1.1 版本在本票定义的真实链路上达到 **accepted**。它不把单次验收外推为长期 **stable**。

## 身份与范围

- 外层 worktree：`C:\Users\KQ_Sh\Desktop\yuki-link\.local\workflow-v1.1-006`
- branch：`codex/workflow-v1.1-006`
- fixed point：`74cad9a8131cede1ccfdd1163036fd551b905953`
- 当前 source-fix HEAD：`2032fcf66db7ae0f6fd23a82d0343f121148b11a`
- 主验收 fixture：`.local/workflow-fixtures/end-to-end-006-TtRZFF`
- clean standalone fixture：`.local/workflow-fixtures/review-004-exhZUF`
- 006 未修改 `.workflow/skills`；当前 Skill source 与 `74cad9a...` 字节一致。
- 005 已批准的全局 `engineering-workflow` 安装计划在本轮只读 verify 再次返回 `verified`，source commit `74cad9a...`、source digest `37c99168...`、plan digest `2767092f...`，全部安装文件 matched、extras 为空。因此本轮不需要新的 protected apply。

## 13 条 Acceptance Criteria

| # | 结果 | Ground truth |
| --- | --- | --- |
| 1 | PASS | 主 fixture 从 Design Handoff / Spec / 无 Notes Ticket 进入 repo-local `engineering-workflow`，实际读取并执行对应领域 Skills。 |
| 2 | PASS | ticket-design → delegated implementation 复用同一真实 Codex thread `01a0b81a-9d09-7fb1-a29c-a053575452bb`；实现提交 `cd8d1b9...`。 |
| 3 | PASS | staged 权限契约变化使 low risk hint 实际升级为 full；fresh coordinator `01a0b81e-...`，Standards / Spec 两轴以 `fork_turns=none` 独立运行。 |
| 4 | PASS | `FIXTURE-006-SPEC-001` / P1 从 open → fixed → fresh focused verified；focused reviewer `01a0b82c-...`，未重复 full。 |
| 5 | PASS | 权限变化实际升级 full；主 fixture 的 acceptance/closeout 文档增量由 fresh evidence Review 核对为 passed / 0 finding，无 upgrade。 |
| 6 | PASS | external interruption 后 fresh recovery 重新验证 Git、完整 Review、测试、receipt/effect 并刷新故意过期的 checkpoint HEAD；原 finding、diff、Next action、Side effects 保持。 |
| 7 | PASS | Acceptance 由 Emilia 使用 Git、filesystem、PowerShell/Node 命令、测试输出、YCA status/output 与内容摘要直接核对；没有用模型自述代替 ground truth。 |
| 8 | PASS | `.workflow/history/FIXTURE-006.md` 由 005 closeout helper 的 observe → generate 流程生成；260000-byte raw sentinel 留在 ignored `.local`，Evidence Review 确认 archive 未复制 raw。 |
| 9 | PASS | fresh recovery thread `01a0b824-f64b-7e11-a2d4-ba4230d10b0b` 不继承旧聊天，仅凭持久化 Ticket/Spec/checkpoint/reports/receipt 恢复到正确 implementation next action。 |
| 10 | PASS | 中断前后 phase、finding、diff、Next action、full report 与 receipt/effect 均保持；`effect.count=1`，没有重做 prepare、初次实现或原 full Review。 |
| 11 | PASS | run `b1677e21-4b43-453c-993d-bba6c7c11221` 的 `codex_get_output(wait_ms=60000)` 实际返回 `wait_elapsed`，同一 run 后续继续产生事件并自然 `completed`，`timeout_ms=null`。旧 `0c688d9^` live-test 每 1500ms 执行 output + status；同一 60s 窗口估算 80 次调用，对比当前 1 次 long-poll，约减少 **98.75%**。该数字明确是基于版本化旧代码 cadence 的估算，不是历史 telemetry 实测。证据：`.local/workflow-validation/006/wait-polling-evidence.json`。 |
| 12 | PASS | clean standalone fixture `review-004-exhZUF` 未传 delegated policy；在未提交 `result.txt` / handoff 时先完成 fresh full 双轴（Standards 0、Spec 0 finding）并最终 revalidate subject，之后才 commit `58413bafa7afd4642d9a1eb512fd8753053f9e4a`。现有 `review-fixture.mjs check` 返回 `artifact-check-passed`、`fixture_only=false`。证据：`.local/workflow-validation/006/standalone-evidence.json` 及 fixture `.local/standalone/`。先前 `review-004-rexp6E` 因尝试读取 fixture 外 memory 被主动停止并排除，不计入验收。 |
| 13 | PASS | 能力状态按下节分层；本票只把已覆盖的真实链路标为 accepted，不声明长期 stable。 |

## 关键 Review / Recovery 证据

- 主 full Review：`.local/workflow-fixtures/end-to-end-006-TtRZFF/.local/full-review.md`；Standards 0 finding，Spec 产生 `FIXTURE-006-SPEC-001`。
- fresh focused re-review：同 fixture `.local/focused-review.md`；F1 fixed → verified，0 open finding。
- fresh recovery：同 fixture `.local/recovery-verification.json`；subject matched、stale HEAD 刷新、关键 checkpoint sections 保持、tracked/index 未在恢复协调阶段修改。
- main-chain Acceptance：同 fixture `docs/acceptance.md` 与 `.local/acceptance-observation.json`。
- closeout evidence Review：同 fixture `.local/evidence-review.md`；mode=evidence，passed，0 finding。
- standalone：`.local/workflow-validation/006/standalone-evidence.json`；实际 YCA run `fe469428-e2ed-4a16-90ce-8e4fbb0b02ba` completed / exit 0 / timeout_ms null。
- wait 对照：`.local/workflow-validation/006/wait-polling-evidence.json`。

## 外层实现与质量门禁

- 原 006 source 实现提交：`458659697abb36fa3170cffe6e2b073ae564ad54`。
- 真实 Acceptance 暴露 helper 将 finding ID 硬编码为 `F1` 的 blocker；按最小范围修复为接受稳定 finding ID，提交 `2032fcf66db7ae0f6fd23a82d0343f121148b11a`。
- 修复后 `npm --prefix tools/workflow-skills test`：**55/55 pass，0 fail、0 skip**。
- `npm --prefix tools/workflow-skills run check`：exit 0。
- `git diff --check`：exit 0。
- source-fix fresh focused Review：PASS / 0 finding / final subject matched。
- 外层原 primary Review：PASS / 0 finding；只有真实 Acceptance 暴露的 source-helper blocker追加了允许预算内的 fresh focused re-review，没有重新运行整票 full Review。

## Capability status

### implemented

Workflow v1.1 所需的 run wait、Skill source/apply boundary、engineering-workflow/checkpoint recovery、Review routing、closeout archive 以及 006 验收 helper 均已实现，并通过对应回归与 Review。

### accepted

当前版本已通过本票定义的一条真实端到端主链，并补充验证 standalone `implement` 向后兼容、observation wait 与 docs/closeout evidence 路由。全局 `engineering-workflow` 安装内容与当前未变化的 repo Skill source 再次 verify matched，因此正式启用无需新的 protected write。

### stable

**未证明。** 本票不承诺多项目、多天、不同网络/客户端条件下的长期稳定性。后续真实使用出现的 drift、outage 或恢复问题按实际事件记录，不由本次 Acceptance 自动升级能力等级。

## 排除与边界

- 被污染的 standalone 尝试 `review-004-rexp6E` 明确排除，不作为成功证据。
- synthetic fixture checker 只证明产物约束与拒绝路径；行为 AC 均另有真实 Agent/YCA/Git/test 证据。
- 本票没有新增 protected/global Skill 写入，也没有关闭 Parent Issue #22。

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

## Implementation Notes

- **依据与状态。** 来源为 [Issue #26](https://github.com/Emilia-tan-Ovo/yuki-link/issues/26)、`docs/specs/emilia-sylvia-workflow-v1.1.md` 的 Implementation / Testing Decisions、`docs/workflow-v1.1-decisions.md` 第 7～10 节，以及 WORKFLOW-002/003 的 source、installer 与 fixture 先例。Implementation frontier 为空，无新 Owner gate；本节是既有决定的实现级收敛，ready for implementation。本轮只交接设计，不执行 implement；验收项保持未完成。
- **职责与 policy。** 延续 repo-local Skill 编排：风险分类只放在 `review-change`；`engineering-workflow` 显式传递本次调用的 workflow review policy、Ticket/Spec、fixed point、内容身份和 handoff 引用，再消费 Review 结果更新 checkpoint。policy 是本次委托 Review 的明确输入，不因目录、Skill 文件或旧 checkpoint 存在而自动启用；缺省按独立 implement 处理。沿用同一 Skill 根寻找依赖，不新增路由服务、CLI、数据库或全局配置。
- **兼容与 handoff。** `implement` 保留 TDD、定向测试、适用的 typecheck、最终完整测试与 commit。无上层 policy 时保持“测试 → 完整 code-review → commit”；有 policy 时完成实现/测试及获准的 commit，持久化 Implementation Handoff，返回上层交给 `review-change`，不先重复 full review。handoff 记录 fixed point、HEAD、变更范围、测试命令/退出结果及受测内容、已知风险/finding、实际 commit 状态；未获 commit 授权或未完成时如实记录，不伪造 SHA。沿用 Ticket handoff/仓库 Notes，执行身份与引用放入现有 checkpoint。
- **风险表示与升级。** 用可读的 mode、实际风险依据、受审范围/内容身份、finding 及证据引用表达路由结果，不做按后缀或分数自动降级的判定器。按已确认的权限/安全、并发、持久化、数据/schema/迁移、外部契约、架构边界、广泛生产变更和显式完整审查要求选择 full；局部明确行为/风险选择 focused；无行为变化的文档与证据记录选择 evidence。Skill/规则 Markdown 也可能改变执行行为，不能仅因扩展名选 evidence。evidence/focused 发现更高风险或规范冲突时升级，缺必要证据不得记作通过；risk hint 不覆盖真实 diff。
- **fresh Review 与 finding。** full 在不继承 implementation 聊天的 fresh reviewer 中调用现有 `code-review`，Standards / Spec 两轴独立、并行、分开报告；只补 fresh 输入与内容覆盖，不重写双轴语义。focused/evidence 同样使用显式最小证据包；focused 携带原 finding/具体风险、相关修后 diff、fixed point 与必要规范，evidence 核对 diff 格式与证据一致性。原 full Review 仍适用、仅修 finding 时默认 fresh focused re-review，保留原两轴结果及 finding 的 open/fixed/verified 状态；修复引入新范围/高风险才升级，不因原票 risk hint 为 high 重跑整票。隔离由 session/sub-agent 实际创建参数与工具事件核验，不能只靠 reviewer 自述 fresh。
- **diff 与证据身份。** 沿用 003 的 Git 动态核验和 schema v1：解析并固定比较基线，明确 committed diff、staged/unstaged tracked diff 与相关 untracked 内容，记录实际受审内容摘要。尤其独立 implement 的 commit 前 Review 不得只看现有 `git diff <fixed-point>...HEAD` 而漏掉未提交实现。review-change 与 code-review 使用同一受审范围；Git/status/字节及测试原始结果是 source of truth，handoff/checkpoint 只是引用。内容、规范或测试环境变化后核对证据适用性，只补受影响检查；无法 fresh 或范围证据不足时保留未完成状态。
- **交付文件与顺序。** 先准备行为 fixture，再实现 `.workflow/skills/review-change/SKILL.md`、调整 `implement/SKILL.md`、`code-review/SKILL.md` 和 `engineering-workflow/SKILL.md` 的 004 兼容段；随后更新 `.workflow/skills/manifest.json` 的 installable/完整文件集，以及 `.workflow/skills/README.md`、`tools/workflow-skills/README.md` 的能力说明。需要的随包 handoff/review 模板须列入 manifest；不改历史 origins、不改 installer 生产安全逻辑、不做 protected apply。最后完成 fixture、安装兼容回归和 fresh Review，验收摘要沿用 003 的本地票据目录先例；005 closeout automation 与 006 全流程验收仍留在各自票据。
- **测试 seam。** 主 seam 延续 `tools/workflow-skills/fixtures/` 的隔离 Git 仓库 + fresh agent 实际执行 engineering-workflow 公共入口；补 review 场景生成/核验器与 README，只准备输入、核对产物和工具 trace，不代替 Agent 路由，也不断言提示词措辞。覆盖 full 双轴隔离、finding 修复只做 fresh focused、docs/acceptance/closeout evidence、evidence/focused 升级、低 hint 的高风险 diff、改变行为的 Skill 文档、未提交/新增文件覆盖、内容或 HEAD 漂移、Review 后 fresh 恢复不重复审查；额外直接调用 implement，分别验证缺省完整 Review 与显式 policy 委托及 handoff/commit。次 seam 复用 `test/workflow.test.js`、`test/safety.test.js` 的公共 installer CLI：新增 review-change 完整文件安装/verify，把当前两处硬编码不可安装断言改成 fixture 内显式设为不可安装的负例，保留批准与漂移保护；必要保护回归复用 bridge 的 workflow-protection/text/control-paths。实现阶段运行工具 check/full suite 及实际 fresh-agent 探针，分别记录确定性测试、行为验收与未运行项，不拿历史 003 结果当本票通过。
- **Deferred low-risk details。** policy/handoff/路由摘要字段拼写、随包模板拆分、fixture 文件名与用例分组由 implement 按既有风格决定；不改变上述缺省行为、fresh 隔离、内容身份与升级边界。下一步读取本 Notes 和当前 worktree 的 `.local/workflow-state/004.md`，刷新 Git/Issue/依赖事实后执行 repo-local implement；本次 ticket-design 到此停止。

## Implementation Handoff

- **入口与 policy。** 本阶段为同一 Ticket Implementation Session 的显式 engineering-workflow continuation，`review_policy: delegated`；Owner/上层保留启动 fresh review-change reviewer 的职责。本 implementation session 没有调用 code-review/review-change、没有启动 reviewer 或代替 Acceptance。上方 Notes 的“只做设计”是上一阶段历史终点，本阶段已有实现和本地 commit 授权。
- **Git 身份。** 分支 `codex/workflow-v1.1-004`，fixed point 为 `ca295f92967d4c5539a70bf8f36abba2a56457de`。本节与实现一同提交；提交主题为 `feat: 实现分级 Review 与 implement 兼容交接（#26）`。精确实现 commit/最终 HEAD 与当前 session 引用在 commit 后写入本 worktree `.local/workflow-state/004.md`，由 Git 重新核验，不在提交内容里循环嵌入自身 SHA。
- **实现范围。** review-change 已具备 full/focused/evidence 与 upgrade-only 规则并可安装；engineering-workflow 显式传 policy 并在 handoff 后交 fresh reviewer；implement 保留 standalone 首次完整双轴 Review，同时支持 delegated 分支。code-review 保留原 smell baseline、两轴独立并行和分开汇总，仅补 fresh context、明确输入及未提交内容覆盖。
- **内容证据。** code-review 随包新增 `review-subject.md` 与只读 `scripts/review-subject.mjs`：捕获 committed/staged/unstaged patch、tracked/untracked 原始字节、index、fixed point/merge-base/HEAD，重复采集检测漂移；保存对象重验返回 matched/stale/error。此 helper 不选 mode、不执行语义 Review，不修改 Git index。implement 的 handoff 模板、manifest 完整文件集和必要说明同步更新；未改 origins、installer `src/`、AGENTS、YCA 生产实现或全局配置。
- **TDD 与定向验证。** 新安装回归先因 `NOT_INSTALLABLE` 失败，交付 Skill/manifest 后转绿；内容采集与行为 fixture 用例先因缺少对应入口失败，实现后转绿。新增 handoff 文件暴露旧测试的 `3 !== 2` 假设，改为完整三文件清单校验并转绿。最后定向测试 **13/13 通过**；raw 输出见 `.local/workflow-validation/004/` 的 `install-{red,green}.txt`、`subject-{red,green,regression}.txt`、`fixture-{red,green}.txt`、`manifest-regression-red.txt`、`targeted.txt`。
- **最终测试。** `npm --prefix tools/workflow-skills test`：**41/41 通过，0 fail、0 skip，exit 0**，包括真实临时 Git/CLI 安装/verify、受审内容/过期身份、已安装 helper 的可移植执行及 fixture 核验器；`npm --prefix tools/workflow-skills run check`：exit 0。本工具无 TypeScript，typecheck 不适用。`node --test tools/codex-session-bridge/test/control-paths.test.js`：1/1 通过。manifest 八项完整文件集和相对 Skill 引用核验通过；`git diff --check` 通过。受测 source/test 的逐文件 SHA-256 在 `tested-source-files.json`，原始输出在 `full.txt`、`syntax.txt`、`control-paths.txt`；最终 commit 前后重核该字节集合。
- **未运行与限制。** 官方 `quick_validate.py` 因本机缺少 PyYAML 报 `ModuleNotFoundError: No module named 'yaml'`；未安装依赖或改全局 Python。当前 worktree 没有 bridge node_modules，未重跑依赖 SDK 的 text/workflow-protection MCP 套件；保护生产代码未改，不能把 003 历史结果写成本轮通过。subject helper 遇到 unmerged index、submodule/特殊文件、超限或采集漂移显式失败；协议要求补足证据，不能静默跳过。
- **行为验收待办。** `review-fixture.mjs` 已准备 standalone、delegated、full、focused、evidence、两种升级和 Skill 行为变更共八例，入口/路径在 `prepared-fixtures.json`，操作见 `tools/workflow-skills/fixtures/README.md`。自动测试使用 synthetic observations，仅验证核验器会拒绝缺少 full、委托分支多跑 Review 或冒充 fresh；**尚未证明真实 Agent 路由/隔离/standalone 顺序**。后续独立 Acceptance 必须从实际工具 trace 核验这些行为，以及内容漂移/恢复不重复 Review。不能因结构化产物通过就勾选全部验收项或宣称 accepted/stable。
- **Finding 与副作用。** 无待处理的实现测试失败；语义 Review pending，不能声明“零 finding 已审查通过”。GitHub #26 仍 open 且没有 Notes，本阶段继续使用已核验本地 mirror，未重试已知 403 的写入。没有 push、PR、Issue 关闭、主工作目录/其他 worktree 修改、protected/global apply；所有安装写入仅发生于测试临时 target。
- **Next action。** 上层以实际实现 commit、上述 fixed point、Ticket/Spec/AGENTS、受测字节与日志启动无历史 fresh review-change。按真实 workflow 行为/架构契约变化评估风险，保留完整双轴要求和未提交范围核验；本 session 到 `phase: review` 交接停止。fresh Review 后才进入独立 Acceptance，未发现新的 Owner 决策门禁。

## Review Finding Fix Handoff

- **修复基线。** fresh full Review 报告为 `.local/workflow-validation/004/review.md`；修复前 HEAD `31fe9cfff4e9996c9d300e4c69e404f07dd3154b`，原 subject digest `d384228865bf4ad455191dc162ceac3d21c2666351d9c8563460857f784d6671`。保留原 Standards / Spec 两轴报告，不重跑 full Review。
- **W004-STD-001 / P2 — fixed, pending fresh verification。** `review-subject.mjs` 现在只读检查 `git ls-files -v -z`，遇到 assume-unchanged / skip-worktree 等非普通状态直接 `HIDDEN_INDEX_STATE` fail closed，不清 flag、不 refresh index。三种组合先红后绿，并逐字节确认 index 未改变。
- **W004-STD-002 / P1 + W004-SPEC-001 / P1 — fixed, pending fresh verification。** helper 不再用 cwd 解析裸 `git`；每次从绝对 PATH 逐项发现 Git，排除受审树及 canonical 后落入受审树的别名，最终以树外 canonical 绝对路径执行。Windows 仓库内 `git.exe` + PATH alias 回归先红后绿；若只剩树内候选则 `GIT_UNAVAILABLE`。
- **W004-SPEC-002 / P2 — fixed, pending fresh verification。** helper 读取 `ls-files --stage -z` 的 index mode，仅接受 `100644` / `100755` / `120000`；mode `160000` gitlink 或其他特殊 mode 在读取工作目录前即 `UNSUPPORTED_INDEX_MODE` fail closed。未初始化、已提交后目录移除两例先红后绿，并确认 index 不变。
- **协议同步。** `review-subject.md` 明确可信 Git 发现、隐藏 index 状态与特殊 mode 的 fail-closed 语义；installer `src/**`、origins、AGENTS、YCA 生产代码和全局配置未修改。
- **验证。** 修后定向 `review-subject.test.js + review.test.js`：10/10 pass；`npm --prefix tools/workflow-skills run check` exit 0；完整 `npm --prefix tools/workflow-skills test`：47/47 pass、0 fail、0 skip；`control-paths.test.js`：1/1 pass；`git diff --check` 通过。原始日志/红绿证据在 `.local/workflow-validation/004/finding-fixes/`。Codex implementation turn 因 usage limit 在完整回归前终止，随后 Emilia 通过 YCA/PowerShell 完成确定性验证；未将失败 turn 当作代码失败。
- **状态。** 四个 finding 只能标记为 `fixed`，尚未 `verified`。下一步使用无 implementation 历史的 fresh focused reviewer，仅核对这四个 ID、修复 diff、直接回归及原 full Review 未变范围；只有出现独立新高风险范围才升级。

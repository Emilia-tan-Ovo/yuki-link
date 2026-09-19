# 005 — 自动生成可追溯的 closeout archive

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 在 ticket 完成时自动生成轻量、可版本化、可供 fresh Agent 恢复历史的 closeout 摘要，同时保留对本机原始 evidence 的追溯，不把大型 runtime 日志提交 Git。

**Blocked by:** 003 — 打通 engineering-workflow 与 checkpoint 恢复闭环.

**Risk hint:** normal

**Status:** ready-for-agent

## Acceptance criteria

- [x] closeout archive 进入版本控制并形成稳定、可读的长期摘要。
- [x] 至少记录 Ticket/Issue、branch/worktree、implementation/review/acceptance session/run、模型/reasoning、代表性耗时/调用、失败/重试、findings 与修复、PR/merge、人工介入点和 raw evidence 位置。
- [x] 原始 JSONL、大型测试输出和 runtime 日志不会被复制进 Git。
- [x] 对缺失/已过期的本机 raw evidence 能明确标记，而不是伪造长期可用性。
- [x] 自动化生成结果可重复核对，并允许 Emilia 在提交前做人类可读的 evidence consistency 检查。
- [x] fresh clone 仅凭 Git 中的 archive 可以理解“这张票发生了什么”，但不会把 archive 当成动态 runtime source of truth。

## Implementation-design boundary

具体使用 Skill、repo-local script、CLI 或其他实现由 ticket-design 决定。

## Implementation Notes

- **依据与状态。** 当前票对应 Issue #27；依据 source Spec 的 Implementation / Testing Decisions、`docs/workflow-v1.1-decisions.md` 第 4～6、8、11、13 节及 003/004 随包 helper 先例。implementation frontier 为空，无需新的 Owner 决策；以下为既有决定与本轮最小 seam 授权的收敛。仅完成本地设计，Acceptance criteria 不勾选；GitHub tracker Notes 待后续获准同步。
- **最小实现 seam。** 在 `.workflow/skills/engineering-workflow/` 随包提供无额外运行时依赖的 Node 脚本 `scripts/closeout-archive.mjs` 和简短输入说明 `closeout-archive.md`，由该 Skill 的 closeout 阶段调用；沿用 code-review 随包脚本、manifest 完整文件集与 tools/workflow-skills 测试先例。不扩展 installer CLI、YCA MCP 或全局 Skills，不改 checkpoint schema。
- **输入与职责。** Emilia 从当前 Ticket、Implementation Handoff、checkpoint 及已核验的 Git / review / acceptance / run 摘要整理一份本地精简 JSON 输入，放在 `.local`；checkpoint 只用于定位，不能作为成功事实来源。脚本校验必要字段、规范化并渲染 Markdown，避免重复手写 archive；不解析任意自然语言 checkpoint 来猜结论，不全盘搜索会话或扫描大型日志。输入覆盖本票全部必填记录项，含 implementation/review/acceptance 的 session/run、model/reasoning、代表性耗时/调用的统计口径、失败/重试、finding 的状态与修复证据、人工介入、PR/merge 和来源引用。未知、不适用、待完成与有证据的“无”分别表达；Emilia 直接验收时不编造 acceptance session/run。
- **输出与一致性。** 固定生成当前仓库 `.workflow/history/<ticket>.md`，内容包含简短过程/结果及上述证据记录；使用稳定顺序、输入中的观察时间与来源身份，使相同输入及证据观察产生相同内容。只输出允许的摘要字段，不透传任意对象或 raw 文本；限制输入/摘要体量，非法输入或越界输出路径显式失败，不留下半成品或破坏已有 archive。先生成可读文件，由 Emilia 对照来源与 Git diff 做 evidence consistency 检查，再在授权范围内纳入 Git；脚本不执行 add/commit/push/PR/merge/Issue close。修正应更新本地输入再生成，不靠手改生成内容维持一致性。
- **本机 evidence 与历史语义。** raw 引用保留定位入口、观察时间、来源/适用内容身份及可用性；脚本只核对显式引用的本机位置，不复制 JSONL、大型测试输出或 runtime 日志。缺失标为 missing；已知内容身份不符或来源明确过期标为 stale；无法核验标为 unknown，文件存在不等于证据有效。archive 冻结的是该次观察，不承诺本机路径在 fresh clone 可访问，也不承担动态 runtime source of truth。PR/merge 尚未发生时明确 pending/unknown，取得外部回执后再生成补记；不为包含归档自身的 commit SHA 制造循环提交。仍需处理的 closeout 动作留在现有 checkpoint 的 Next action。
- **主要文件与顺序。** 先围绕公共脚本输入/输出编写 `tools/workflow-skills/test/closeout-archive.test.js`，再实现上述脚本/说明并替换 `engineering-workflow/SKILL.md` 的 005 占位段；同步 `.workflow/skills/manifest.json`、`tools/workflow-skills/package.json` 的 check、`test/workflow.test.js` 的随包文件断言及两处 Skill/tool README。最后用本票真实可得证据生成 `.workflow/history/005.md` 并核对，未发生事项如实标注；不改历史 origins、installer 安全逻辑或业务代码。具体参数拼写、JSON 字段名、Markdown 排版和体量上限留给 implement 按现有约定确定。
- **最小测试 seam。** 采用 Spec Secondary seam 1：Node test 通过公共脚本在临时仓库读取精简输入，核对字段完整/中文可读、相同输入重复生成一致、missing/stale/unknown/不适用不变成成功、非法输入/路径失败且保留原文件，以及 raw 哨兵文本未进入输出、原始文件未改变。以仅含 Git 产物的临时检出验证 archive 自足、无 raw 也能理解历史；这不启动 fresh Agent。仅补一条现有 installer 公共 seam 的随包安装/执行回归，确认 helper 不依赖 source checkout；实现结束运行 tools/workflow-skills 定向测试、full suite 与 check。006 的 fresh-session 全流程 fixture、drift/recovery、压力测试及额外研究不在本票执行。
- **交接。** 设计时分支 `codex/workflow-v1.1-005`、HEAD `59271cd546c9aaa6f89edb93cccaf20df6d8406a`，初始工作区干净且当前 worktree 尚无 `.local/workflow-state/005.md`；这些仅为本次观察，实现前重新核验。Notes 写入并回读后 ready for implementation；下一步须取得明确实现授权，再按本 Notes 执行 repo-local implement。本轮不实现、不启动 reviewer、不提交 commit。

## Implementation Handoff

- **入口与授权。** 本次为同一 WORKFLOW-005 Ticket Implementation Session 的明确实现授权；`review_policy: delegated`，接收方为 Emilia，reviewer 启动权由 Emilia 保留。本 session 未调用 code-review/review-change、未启动子 Agent/reviewer。Owner 本轮明确将最终 full test/check/commit 交给 Emilia；上方 Notes 的完整测试/commit 顺序不覆盖本轮限制。
- **Git 身份与范围。** worktree 为当前独立 `workflow-v1.1-005`，branch `codex/workflow-v1.1-005`，fixed point 与观察 HEAD 均为 `59271cd546c9aaa6f89edb93cccaf20df6d8406a`。开始时只有本票 Implementation Notes 未提交，已保留；本次所有实现均未提交，无新 commit SHA。只改 005 的随包 helper/说明、Skill closeout 接入、manifest、tools/workflow-skills 的测试/check 入口与必要 README，以及本 Ticket。未改 installer 生产安全逻辑、YCA API、全局安装或 006。
- **实现行为。** 新增 `engineering-workflow/scripts/closeout-archive.mjs` 与 `closeout-archive.md`。`observe <repo> <input>` 仅探测明确本机位置并输出观察 JSON；`generate <repo> <snapshot>` 从冻结精简输入确定性生成 `.workflow/history/<ticket>.md`，返回内容 SHA-256。两步分开避免 runtime 变化令同一快照输出漂移；未引入新 runtime 服务。必要字段严格校验、摘要文字转义、输入/输出各限 64 KiB；非法输入或路径 exit 1，链接输出拒绝，同目录临时文件写齐后替换。raw 不读取/复制，保留引用及 missing/stale/unknown/not-applicable；available 仅表示观察时文件存在。
- **测试与本地静态自检。** 仅执行 `node --test tools/workflow-skills/test/closeout-archive.test.js`：首个用例因 helper 不存在预期红灯（exit 1），实现后 1/1 绿灯（exit 0），补齐必要状态/非法输入/路径用例后最后一次 **4/4 通过（exit 0）**。覆盖确定性与 pending、raw 哨兵不复制、证据状态、失败保留既有文件和链接目录越界。只复制 Markdown 到无 raw 目录检查独立阅读，不冒称真实 Git clone 或 fresh Agent 验收。Node v24.18.1；raw 输出在 `.local/workflow-validation/005/targeted-{red,first-green,final}.txt`，受测 helper/test SHA-256 在同目录 `tested-source-files.json`。已回读实际 diff/新增文件，静态核对 manifest 完整文件集、JSON、check 入口、pending 状态及受测字节未变化；没有执行 npm check、完整 suite 或语义 Review。
- **归档准备。** 已保存 `.local/closeout/005-input.json`，包含实际实现/定向测试摘要、403 历史来源和未完成事项；review/acceptance/PR/merge 保持 pending，未独立核验的当前 run/model/reasoning 保持未知。本轮未生成最终 `.workflow/history/005.md`；Emilia 后续刷新事实与观察时间，按输入说明 observe/save/generate，再回读核对并纳入 Git。GitHub #27 Notes 同步由 checkpoint 记录为 integration 403，本 session 未重试。raw、输入和测试日志均留 `.local`。
- **Emilia 的机械待办。** 从本 worktree 执行 `npm --prefix tools/workflow-skills test`（含新增 installer 随包/独立执行回归）、`npm --prefix tools/workflow-skills run check` 及 `git diff --check`；检查相关 untracked 文件与最终写集，按授权 commit 并在 checkpoint 记录实际 SHA/内容绑定，再由 Emilia 启动所需 fresh review。最终 full test/check/commit **pending**；本 session 没有运行 installer apply/verify（新增回归也未执行）、push/PR/merge 或 protected apply。普通全局安装不作为本票机械待办。
- **限制与后续。** 尚未取得 Review/acceptance 结论，finding 状态 pending，不能声明零 finding、accepted 或 stable。脚本检查输入格式与本机位置，证据适用性/耗时调用口径/finding 修复仍由 Emilia 根据来源核对；stale 是上游明确提供的过期结论，available 不自动证明有效。生成器要求单 writer，不提供并发对抗隔离。安装版可移植回归已编写但未运行，最终归档与版本控制验收仍由后续事实完成。无需扩展到 006、drift/recovery 或压力测试。

## Emilia Mechanical Validation

- npm --prefix tools/workflow-skills test：51/51 通过，0 fail，exit 0；完整输出保存在 .local/workflow-validation/005/full.txt。
- npm --prefix tools/workflow-skills run check：exit 0；包含 closeout helper 的 Node 语法检查，输出保存在 .local/workflow-validation/005/check.txt。
- git diff --check：exit 0。提交前写集仅包含本票的 engineering-workflow helper/说明/接入、manifest、workflow-skills 测试/check/README 与当前 Ticket；.local 证据未进入 Git。
- Review 仍为 delegated / pending；Acceptance、最终 archive、PR/merge 与 protected global Skill apply 尚未发生，不据此升级为 accepted/stable。

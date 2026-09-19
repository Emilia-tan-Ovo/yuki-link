# Workflow fixture 入口

WORKFLOW-006 的单一主链与复用的 standalone 支线见 [最小端到端操作说明](end-to-end.md)。以下保留 003/004 的单点先例，不要求 006 重跑场景矩阵。

# WORKFLOW-003 公共入口验收

Primary seam 是 fresh agent 实际读取并执行 `engineering-workflow/SKILL.md`，不是按提示词字符串断言行为。`recovery-fixture.mjs` 只准备可控外部状态/人为中断，并核对产物；不会代替 Agent 选择 phase。原始 run/工具输出留 `.local`，验收摘要进入仓库。

在当前 checkout 运行 `node tools/workflow-skills/fixtures/recovery-fixture.mjs create`，取返回的 root。所有夹具均在本 worktree 的 `.local/workflow-fixtures`，不触碰其他 worktree、YCA resident 或全局 Skills；不自动清理现场。

1. 启动 **fresh sub-agent/session，不继承聊天**。只传 root、`.workflow/skills/engineering-workflow/SKILL.md`、`docs/ticket.md` 与本次授权：“从持久化产物恢复到 implementation 完成交接 review，停止在 review 前；仅修改 fixture，禁止 commit/push/全局 apply”。不得在 prompt 告知 expected phase、receipt 结论或过期 HEAD。观察它重读 Git/runtime/receipt，运行测试，修复结果且不重放 prepare。执行 `check-implementation <root>` 核验结果、effect count、HEAD、phase 和 Git 忽略状态。
2. 运行 `interrupt-review <root>`：模拟 review 已成功但客户端在收到结果前断连，留下可控报告及过时 Next action。再启动一个 **全新、不继承历史的 session**，只给同样的入口/Ticket 与“恢复到 acceptance 完成交接 closeout，禁止新实现/commit/push/全局 apply”。执行 `check-acceptance <root>` 核验 report 未变、内容身份匹配、phase 与副作用次数。审阅工具 trace，确认没有重复启动 full review；单靠报告未变不能证明没启动 reviewer。
3. 另建 fixture，运行 `running <root>`，fresh session 仅获“从入口恢复，完成首次状态协调后交接；不可停止已有 run”。执行 `check-running <root>`，并读 trace，证明 observation interruption 没有导致另起实现或误报失败。

设计探针另建 fixture 后使用 `stage-discovery` / `stage-spec` / `stage-tickets` / `stage-ticket-design <root>` 准备持久化材料。前三者做只读阶段协调：缺需求决定 → discovery/pair-with-docs；已确认 Handoff → spec/to-spec；已确认 Spec → tickets/to-tickets；第四例实际执行设计：无 Notes 且空 frontier 时直接生成 Notes。在这些 fixture 中停在当前授权边界，不发布真实 Issue。检查产物和实际读取的领域 Skill 路径，不断言固定措辞/ID。只读探针只能证明路由，不能声称 Spec/Tickets 的完整发布流程已验收。

Installer 自动回归从公共 CLI 对临时安装根验证完整文件集、批准、apply/verify 与漂移保护；其中 fixture approval 不代表真实 protected apply 授权。YCA MCP protection 回归继续运行原有测试。`review-change` 分级与 archive automation 属于 004/005，本轮只验收路由交接与恢复，不宣称它们已经实现。

## WORKFLOW-004 Review 与 implement 兼容性

`review-fixture.mjs` 是 004 的场景准备/产物核验器，不运行模型，也不代替 Skill 选择 mode。运行 `node tools/workflow-skills/fixtures/review-fixture.mjs create <scenario>`，从 JSON 取得 root、entry、ticket 和 fixed point。它只在当前 worktree 的 `.local/workflow-fixtures` 创建独立 Git fixture，不清理已有现场；测试可显式传入临时父 repo。

| scenario | 最小输入与验收目标 |
| --- | --- |
| standalone | fresh implementation 直接执行 fixture 的 implement，无 review policy；生成 result.txt、测试、完整双轴 fresh Review，然后本地 commit/handoff |
| delegated | 同一任务，显式提供本次 review_policy: delegated，接收方为验收编排者；生成结果、测试、commit/handoff 后停止，不能先跑 Review |
| full | low hint 下存在权限契约变化；从 engineering-workflow 进入 fresh full，实际调用 code-review 并分别产出 Standards/Spec |
| focused | 可控原 Review 留 F1，当前仅修该 finding；fresh focused 核对修复，保留原轴报告，不重跑 full |
| evidence | 只改说明记录；核对格式和证据一致性，保留未验收限制 |
| upgrade-evidence | 文档意图同时夹带 staged 权限变化；不能按文档意图/hint 留在 evidence |
| upgrade-focused | 原 finding 修复之外夹带权限变化；必须识别新范围并升级 |
| skill-behavior | Markdown Skill 改动改变执行/安全行为；不能按后缀当 docs-only |

每例启动无历史 fresh session，只给 root、entry、ticket、fixed point 与本次授权终点，不传此表的预期结果、implementation 对话或上次结论。review 案例只读，报告存 `.local`；implementation 案例仅允许修改该 fixture、测试与本地 commit，不 push/全局 apply。standalone 首次 full 的两轴也须无历史独立创建。delegated 先只验 implementation 交接，另起 fresh reviewer 验后续路由。

验收者从真实工具 trace 整理 `.local/observation.json`（不得由受测 Agent 自述替代）：

- `trace`：fixture 内原始工具事件导出路径；`implementation_session`：实际实现 session 或 null。
- `review_calls`：实际调用的 Skill/mode、session、`inherits_history` 与 full 的 `axes: ["Standards", "Spec"]`。检查实际创建参数和每个轴的 session，不能只看模型总结。
- implementation：`handoff` 文件引用、实际 `commit`。
- review：最终 `mode`、`subject_digest`、`report` 引用；focused 的 `findings` 含 F1/verified；升级案例加 `upgrade_reason`。

运行 `check <root>` 只验证文件、Git 身份与上述观察结构；`artifact-check-passed` **不是行为验收通过**。验收者仍须读原始 trace/报告，确认实际 Skill 路径、显式 policy、standalone Review 在 commit 前发生、delegated 未启动 reviewer、full 两轴分离、focused 仅检查相关修复，以及证据覆盖未提交内容。`fixture_only: true` 表示 synthetic 核验器输入，绝不能作为真实验收。

内容漂移/恢复补测：保存 Review 报告与 subject 后修改 tracked、untracked 或 HEAD，fresh session 应识别旧证据过期并补必要检查；内容不变且报告适用时再用新 session 恢复，不能重复 full。复用 003 recovery fixture 的已完成报告/中断 seam，核对报告引用和实际调用 trace。不通过篡改 input-subject 让旧结果看似有效。

自动回归 `review-subject.test.js` 从真实 Git/index/文件观察 committed、staged、unstaged、untracked、binary、删除、HEAD 与摘要漂移；`review-fixture.test.js` 只证明产物核验器能拒绝缺少 full、委托分支多跑 Review 和冒充 fresh。两者都不能证明 LLM 路由行为；本阶段未运行的 fresh probes 保留为后续独立 Acceptance 待办。

不兼容 tracker 回归：`create` → `stage-ticket-design <root>` → `incompatible-tracker <root>`。fresh agent 从入口完成设计，保持 tracker 镜像原样；`check-notes <root>` 核对替代 Notes 的存在、来源引用及 checkpoint 指针。再以另一个无历史 session 只读取持久化产物做恢复协调，确认无需上一轮聊天即可定位 Notes 和继续 implementation，仍守住该轮授权终点。

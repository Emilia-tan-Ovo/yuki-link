# WORKFLOW-003 公共入口验收

Primary seam 是 fresh agent 实际读取并执行 `engineering-workflow/SKILL.md`，不是按提示词字符串断言行为。`recovery-fixture.mjs` 只准备可控外部状态/人为中断，并核对产物；不会代替 Agent 选择 phase。原始 run/工具输出留 `.local`，验收摘要进入仓库。

在当前 checkout 运行 `node tools/workflow-skills/fixtures/recovery-fixture.mjs create`，取返回的 root。所有夹具均在本 worktree 的 `.local/workflow-fixtures`，不触碰其他 worktree、YCA resident 或全局 Skills；不自动清理现场。

1. 启动 **fresh sub-agent/session，不继承聊天**。只传 root、`.workflow/skills/engineering-workflow/SKILL.md`、`docs/ticket.md` 与本次授权：“从持久化产物恢复到 implementation 完成交接 review，停止在 review 前；仅修改 fixture，禁止 commit/push/全局 apply”。不得在 prompt 告知 expected phase、receipt 结论或过期 HEAD。观察它重读 Git/runtime/receipt，运行测试，修复结果且不重放 prepare。执行 `check-implementation <root>` 核验结果、effect count、HEAD、phase 和 Git 忽略状态。
2. 运行 `interrupt-review <root>`：模拟 review 已成功但客户端在收到结果前断连，留下可控报告及过时 Next action。再启动一个 **全新、不继承历史的 session**，只给同样的入口/Ticket 与“恢复到 acceptance 完成交接 closeout，禁止新实现/commit/push/全局 apply”。执行 `check-acceptance <root>` 核验 report 未变、内容身份匹配、phase 与副作用次数。审阅工具 trace，确认没有重复启动 full review；单靠报告未变不能证明没启动 reviewer。
3. 另建 fixture，运行 `running <root>`，fresh session 仅获“从入口恢复，完成首次状态协调后交接；不可停止已有 run”。执行 `check-running <root>`，并读 trace，证明 observation interruption 没有导致另起实现或误报失败。

设计探针另建 fixture 后使用 `stage-discovery` / `stage-spec` / `stage-tickets` / `stage-ticket-design <root>` 准备持久化材料。前三者做只读阶段协调：缺需求决定 → discovery/pair-with-docs；已确认 Handoff → spec/to-spec；已确认 Spec → tickets/to-tickets；第四例实际执行设计：无 Notes 且空 frontier 时直接生成 Notes。在这些 fixture 中停在当前授权边界，不发布真实 Issue。检查产物和实际读取的领域 Skill 路径，不断言固定措辞/ID。只读探针只能证明路由，不能声称 Spec/Tickets 的完整发布流程已验收。

Installer 自动回归从公共 CLI 对临时安装根验证完整文件集、批准、apply/verify 与漂移保护；其中 fixture approval 不代表真实 protected apply 授权。YCA MCP protection 回归继续运行原有测试。`review-change` 分级与 archive automation 属于 004/005，本轮只验收路由交接与恢复，不宣称它们已经实现。

不兼容 tracker 回归：`create` → `stage-ticket-design <root>` → `incompatible-tracker <root>`。fresh agent 从入口完成设计，保持 tracker 镜像原样；`check-notes <root>` 核对替代 Notes 的存在、来源引用及 checkpoint 指针。再以另一个无历史 session 只读取持久化产物做恢复协调，确认无需上一轮聊天即可定位 Notes 和继续 implementation，仍守住该轮授权终点。

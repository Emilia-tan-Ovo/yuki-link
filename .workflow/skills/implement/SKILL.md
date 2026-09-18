---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

## 1. 读取入口

读取 Ticket、source Spec、适用规范及 Implementation Notes；Notes 在替代文件时按同根 engineering-workflow 的恢复协议定位。记录实际 worktree/branch、开始时 fixed point SHA、HEAD 和已有变更归属。恢复时先核验 checkpoint 的动态事实，不重做已有设计、不覆盖无关工作。

确定本次 review policy：只有调用者**明确将完成后的 Review 委托上层**时才使用 delegated 分支。可用 `review_policy: delegated` 和接收方/报告位置表达，也接受含义相同的明确指令；这是流程委托，不授予额外操作权限。目录、文件、旧 checkpoint 或安装了 engineering-workflow 都不能自动启用 policy。没有本次委托时默认 standalone；用户要求 full 时该要求随 handoff 保留。

## 2. 实现与测试

Use /tdd where possible, at pre-agreed seams. Run typechecking regularly where applicable, single test files regularly, and the full test suite once at the end.

按确认的范围推进；失败→最小修复→定向验证。保留实际命令、退出结果、受测内容与环境限制；不适用的 typecheck 明确标注。完成标准是实现和必要测试已有可核验结果，不是模型自述成功。

## 3. 按 policy 交接

### delegated：workflow 调用

实现和测试完成后，在授权范围内 commit 到当前分支；先核对只包含本任务文件。按 [Implementation Handoff](handoff-template.md) 持久化并回读验证，返回上层，由上层在 fresh context 调用同根 review-change。

本 implementation session 不调用 code-review/review-change，不自行给实现下审查结论。上层若明确接手启动 reviewer，完成交接后停止。未获 commit 权限或提交失败时如实记录未提交内容、原因和下一步；不伪造 commit、不把交接误报成 Review/acceptance 通过。

### standalone：无本次 workflow policy

保持默认顺序：完成实现/测试 → **完整 code-review** → 处理 finding → commit。读取同根 `code-review/SKILL.md`，给无历史 fresh reviewer 提供 fixed point、[完整受审内容](../code-review/review-subject.md)、Ticket/Spec、规范和必要测试证据；不得因 diff 小或 docs-only 自动换成 evidence。

提交前 Review 包含本票 staged/unstaged/untracked 实现。原 full Review 的 finding 修复后，读取同根 review-change 做 fresh focused re-review，发现独立新风险则升级；首次完整双轴义务不变。缺依赖/无法创建隔离 reviewer 时保留审查未完成，不以自审替代。

Review 通过后仅提交本票内容；重新核对 commit 内容与受审字节，提交 hook 或并发变化引入差异时使相应证据失效。持久化同一 handoff，包含实际双轴结果与 commit 绑定；不得宣称尚未执行的 acceptance 已通过。

## 4. 返回可恢复证据

两条分支均产出 handoff；本票 fresh session 必须能据其引用继续。上层负责 checkpoint phase：delegated 完成后为 review；standalone 已有效通过 Review 后交 acceptance，有待修 finding 则 implementation。commit 的精确 SHA 与最新内容摘要可在 commit 后写入非 Git checkpoint，避免把包含自己 SHA 的文件反复提交；handoff 保留该定位引用及提交主题。不得为保存证据自动 push、PR、安装或关闭 Issue。

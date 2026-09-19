---
name: review-change
description: 按实际 diff 和风险选择 full、focused 或 evidence Review，支持 finding 修复后的 fresh 定向复核。
disable-model-invocation: true
---

# Review Change

负责风险路由与审查交接；implementation、checkpoint 和 acceptance 由上层负责。读取同一 Skill 根中的 `code-review`，保留其 Standards / Spec 双轴；所需依赖缺失则报告未完成。

## 1. 建立受审对象

从显式输入读取 worktree、fixed point、目标 HEAD/内容身份、Ticket/Spec、规范和必要测试证据；有 finding 时增加原 finding、原 Review 报告及修复基线。先按 [受审内容协议](../code-review/review-subject.md) 捕获当前对象，核对 handoff 是否仍匹配。既包含 fixed point 后 committed 变化，也包含 staged、unstaged 与相关 untracked 文件。未提交实现不能因 HEAD diff 为空被跳过。

审查输入是引用与事实，不是 implementation 聊天。若当前 context 含实现历史，只准备证据包并启动无历史的 fresh reviewer，或返回上层请求 fresh session；不能在本 context 得出审查结论。使用 sub-agent 时明确 `fork_turns: "none"` 或等价隔离，记录真实创建参数/session 引用。已经是 fresh reviewer 时直接执行，不递归创建相同角色。

## 2. 选择模式

读取实际变化和影响范围，再记录 `mode`、风险依据、内容身份与检查范围。risk hint 仅是调查线索；文件扩展名不代表风险，Skill/规则文档可能改变权限或执行行为。

| 模式 | 适用证据 | 动作 |
| --- | --- | --- |
| full | 权限/安全、并发、持久化、数据/schema/迁移、外部重要契约、架构边界、广泛生产变更，或用户显式要求完整审查 | 在 fresh context 中实际读取并执行同根 `code-review/SKILL.md`；默认由同一 fresh reviewer 串行执行 Standards → Spec 并分开报告。只有 Owner 明确批准第二条活跃模型线时才允许并行 reviewer |
| focused | 边界明确的局部 bug fix、具体风险、小范围行为变化，或已审查内容的原 finding 修复 | fresh reviewer 只核对原 finding/风险、修后相关 diff、fixed point 和必要规范/测试，检查修复直接影响的回归 |
| evidence | 无生产/执行行为变化的文档、验收记录、closeout 或元数据 | fresh reviewer 做 diff 有效性和证据一致性核对 |

**Upgrade-only**：本次对象一旦发现更高风险就升级并记录原因，不能为了成本或预设 hint 降级。evidence 发现行为变化至少升级 focused；命中 full 风险或规范冲突影响更广时升级 full。focused 超出已界定风险/修复范围时重新判定，必要时 full。证据不足时调查或报告 incomplete，不能以更便宜的模式冒充通过。

**Finding re-review**：先核对原 Review 的未变部分仍适用，再以修复前 SHA/内容快照作为局部比较基线。只修原 finding 时默认 fresh focused，不因原票曾经 full/high 就重跑整票；这不是对原审查降级。保留票据 fixed point、原两轴结论及 finding 标识。无法证明未变部分仍适用、出现独立新范围/高风险，或用户要求再次 full 时升级。

## 3. 执行与回传

- full：遵循 `code-review` 的 Standards / Spec 两轴结果，不能合并、跨轴重排或用一个轴覆盖另一个。
- focused：每项报告原 finding/风险、受检修复、相关回归证据与 open/fixed/verified 状态。代码已修改只算 fixed，只有 fresh 检查有依据才 verified；局部通过不等于整票通过。
- evidence：运行涵盖 committed、index、worktree 的 `git diff --check`，并实际读取新增文件；核对文档声称的 commit、测试退出码、报告路径、受测内容、验收级别与原始事实。缺失报告/过期证据列为 finding 或 incomplete，不能把“模型说成功”当证明。closeout 只能确认记录与事实一致，不能代替 acceptance 或关闭 Issue。

完成前重新捕获对象，确认内容与证据未漂移。报告持久化到调用者给定的当前 worktree 本地证据位置；未指定则用 `.local/workflow-state/<ticket>-review.md`，先检查忽略规则和既有文件，保留旧报告。

报告至少包含：fixed point/merge-base/HEAD、subject 摘要及文件引用、mode 与升级理由、受检范围/排除项、规范与测试证据身份、真实 reviewer 隔离引用、各 finding 状态、结论（passed/findings/incomplete）和下一步。有漂移或未完成检查时不能输出 passed。

将报告交还上层：有待修 finding → implementation；完成且适用 → acceptance。已有充分审查证据仍适用时复用；只补缺失轴或受影响检查，不重复全量审查。此 Skill 不实现修复、不替上层提交、部署或验收。

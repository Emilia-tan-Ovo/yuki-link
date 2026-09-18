# Workflow v1.1 — Skill / AGENTS 优化计划（草稿）

> 本文件只描述拟议变更。当前 YCA 安全策略禁止通过工具直接修改 AGENTS.md 和全局 Skill 安装文件，因此先在优化 worktree 中审阅方案，确认后再安全应用。

## 设计原则

不要把所有编排逻辑塞进现有专用 Skill。保留它们的单一职责，再增加一个上层 workflow/router 负责阶段切换、session 生命周期、review 分级和 checkpoint。

## Proposed: 新增上层 workflow Skill

暂名：`engineering-workflow`

职责：

- 识别当前阶段：discovery / spec / tickets / ticket-design / implementation / review / acceptance / closeout；
- 调用已有 `pair-with-docs`、`to-spec`、`to-tickets`、`ticket-design`、`implement`；
- 管理 implementation / review / focused re-review session 分离；
- 读取/更新 workflow checkpoint；
- 按风险选择 review 路径；
- closeout 时生成轻量 archive；
- 不替代任何领域 Skill 的内部职责。

## Proposed: pair-with-docs

保留现有核心行为，只补两条上层约束：

- 阶段结束时输出一个可恢复的 Design Handoff：已确认决定、仍未决点、下一步 `to-spec`；
- 不把运行期 session/run 写入 CONTEXT.md，动态状态交给 workflow checkpoint。

## Proposed: to-spec

保留“不重新采访用户”。

优化：

- 输入应优先来自已确认 handoff + CONTEXT/ADR，而不是依赖整个长聊天仍在上下文；
- Testing seam 的用户确认完成后，把 seam 决定写入可恢复 handoff；
- Spec 发布后 checkpoint 进入 `tickets` phase。

## Proposed: to-tickets

保留 vertical slice / blocking edges。

优化：

- 每张票额外标注 risk hint：low / normal / high，只作为 review 路由线索，不作为永久评级；
- ticket 创建后 checkpoint 只记录 frontier，不复制全部票据正文；
- 风险由 workflow router 最终结合真实 diff 再判断，不能仅凭 ticket 初始标签决定。

## Proposed: ticket-design

保留 implementation frontier 和“只问高杠杆决定”。

优化：

- 若 frontier 在代码调查后为空，允许直接产出 Implementation Notes 并声明 ready，不强制制造用户问题；
- handoff 时写 checkpoint：fixed point、worktree、implementation decisions、deferred details、next action；
- 不自动调用 implement。

## Proposed: implement

当前冲突：现行 Skill 写死“Once done, use /code-review”。

建议改成：

1. 继续保留 TDD、定向测试、typecheck、full suite、commit；
2. 实现完成后返回一个 Implementation Handoff：
   - fixed point / HEAD；
   - changed scope；
   - tests；
   - known risks；
   - commit；
3. 若存在上层 workflow review policy，由 router 选择 review 方式；
4. 若没有上层 policy，保持向后兼容：默认调用完整 `/code-review`。

这样不会破坏单独使用 implement Skill 的旧习惯。

## Proposed: Review 路由

不直接削弱现有 `code-review`。保留其完整 Standards + Spec 双轴定义。

新增一个轻量 router，例如 `review-change`：

### full
适用：
- 权限、安全、并发、持久化；
- 外部 API/数据契约；
- 架构边界；
- 广泛生产代码改动；
- 用户显式要求完整 review。

动作：调用现有 `code-review`，fresh reviewer context。

### focused
适用：
- 局部 bug fix；
- 已知 finding 的修复；
- 小范围行为变化。

输入只包含：fixed point/diff + 具体风险/finding + 相关规范。

### evidence
适用：
- docs-only；
- acceptance/closeout；
- 不改变生产行为的记录更新。

动作：`git diff --check` + evidence consistency；发现真实风险时升级 full。

任何模式都允许 Emilia 根据实际 diff 升级；不得为了节省成本降级明显高风险改动。

## Proposed: code-review

完整双轴逻辑本身保留。

可优化但不改变语义：

- 强调 reviewer fresh context；
- 禁止继承 implementation session 的聊天历史作为隐式证据；
- fixed point/spec/standards 必须显式提供/发现；
- finding 修复后的检查交给 focused review，不默认重新跑完整双轴。

## Proposed: AGENTS.md 增补

AGENTS 只写稳定规则，拟增加：

- 不依赖隐藏模型上下文保存开发状态；
- 阶段边界写 repo-local checkpoint；
- fresh session 恢复协议；
- Review session 与 implementation session 默认分离；
- 大日志先确定性提取；
- 任务等待按“是否持续推进”而非统一硬超时；
- 能力声明继续区分 implemented / accepted / stable。

不写当前 Issue、session id、run id 等动态值。

## 上下文问题的目标

我们不解决“怎么看上下文还剩多少”。

我们解决：

> 即使上下文现在立刻清空，下一位 Emilia/Sylvia 是否能从外部状态继续正确工作？

只要答案是“能”，上下文窗口本身就从单点风险变成缓存。

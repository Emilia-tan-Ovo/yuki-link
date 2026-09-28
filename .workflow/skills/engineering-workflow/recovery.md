# 恢复协议

## 1. 按信息分层重建

先按 [工作项生命周期](SKILL.md#工作项生命周期) 定位已记录的 work item、generation 与执行事实。已有运行时 journal 时核对其 revision 与 operation，checkpoint 不反向覆盖它；尚未实现 gate 时核对 checkpoint 及原始证据，缺失 ID 保持未知，不虚构运行时支持。

可以先用 checkpoint 文件名定位 Ticket，但正式读取与理解顺序固定为 Ticket → source Spec → CONTEXT/ADR/AGENTS → Implementation Notes → checkpoint。缺失产物先按仓库/Git/Issue 引用寻找；不能用 checkpoint 摘要替代完整要求，也不能把未知状态自动升级为成功。

Ticket 没有内嵌 Notes 时，先查仓库约定的替代 Notes；无约定则读 `docs/implementation-notes/<ticket>.md`。这是 tracker 不支持扩展时的持久化实现决定，不因为票据本体没有 section 就重做 ticket-design。确认 Notes 的 Ticket/Spec 引用与当前任务一致，再读取 checkpoint。

核对 schema、路径、分支和固定点。不同 worktree 的状态不得直接套用。无 checkpoint 时从实际产物推导最早未完成阶段并创建边界记录；checkpoint 损坏时保留原文件作本地诊断，只从外部事实重建，不能执行损坏的 Next action。

## 2. 重新验证易变事实

| 事实 | source of truth 与刷新动作 | 失效后的行为 |
| --- | --- | --- |
| worktree / branch / HEAD / diff | 在当前目录重读 Git toplevel、branch、HEAD、status、fixed-point diff，包含相关 untracked 文件 | 内容或身份变化使对应测试/Review 范围过期；查清变化来源，不能 reset/覆盖现场 |
| work item / generation / session / run | 按引用查询已有持久化记录、status/output/events，核对范围、授权、最新内容和代归属 | 根据生命周期规范判断下一步；未知先 reconciliation，不能用新执行替代核验 |
| tests | 重读测试报告、exit code、受测内容/命令及相关依赖/配置；必要时运行与变化对应的测试 | 报告缺失、内容/环境变化或旧证据不足时补跑受影响检查，不用模型自述通过 |
| Review | 读 reviewer 报告与 fixed point、受审内容、标准/Spec 版本、未关闭 finding，核对真实 diff | 完全匹配可复用；只修 finding 时独立定向核对；独立范围/风险变化时重新选择必要 review |
| runtime / acceptance | 重新查询当前进程身份、selected/running release、配置和实际验收响应（仅与本票相关项） | 一次探测不是永久配置；依赖变化需要相应回归，不直接重启未知归属服务 |
| 外部副作用 | 查询 Git commit/远端 ref、现有 PR/Issue、apply plan/receipt 与实际目标内容 | completed 且匹配则跳过；unknown 先调查，查不清则保留现场/阻塞该动作；只能在证明未发生且授权仍有效后重试 |

每项标注 verified / stale / unknown / not-applicable，并指向本次观察。不要为纯文档 fixture 启动真实 执行工具 或 runtime；可控 fixture 文件是测试输入，必须明确区别于真实工具事件。大型数据先以确定性筛选得到有关 ID/时间窗的短摘要。

## 3. 恢复正确 phase

- external interruption 只描述观察/对话中断；run 自己的失败必须由状态/退出证据证明。正常工作不因观察窗口到期而停止。
- implementation 中断：保留已有改动，从原工作项与执行事实恢复；按生命周期规范确定 continuation 或 generation replacement，不重做已完成动作。
- review 中断：查找 reviewer 的原报告/终态；完成且适用时进入 acceptance。只有部分结果时仅恢复缺失轴/未完成检查，不丢已完成轴。
- acceptance 中断：已完成 full review 仍适用则直接恢复验收。已有充分验收证据则只做剩余项/closeout，不重跑 full review。
- finding 修复：恢复原 repair 工作项、issue set 和原审查证据，按生命周期规范处理等待验证、复核失败与预算；代码已修改不能直接记作 verified。

如果 Next action 与最新事实冲突，先更新恢复路径/阶段及原因，再执行校正后的动作。没有变化则不因一次读取重写 checkpoint。任何 protected/global apply 仍需要具体计划的 Owner 批准；中断恢复不继承未记录、无法验证或已过期的批准。

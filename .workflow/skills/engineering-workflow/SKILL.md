---
name: engineering-workflow
description: 从已确认 Design Handoff、Spec 或 Ticket 推进工程工作流，或在中断后从持久化 checkpoint 恢复。
disable-model-invocation: true
---

# Engineering Workflow

编排已有领域 Skills，管理阶段边界、session 和恢复证据；各领域的设计、实现与审查规则仍由对应 Skill 负责。

## 1. 建立入口与授权

记录用户给出的 repo/worktree、Ticket / Spec / Design Handoff 和本轮授权终点。显式调用本入口允许按授权范围读取并执行下表的领域 Skill 文件；`disable-model-invocation` 仍保留独立设计 Skill 的手动入口，不把本入口当作实现或外部写入的无限授权。只有设计授权时停在设计 handoff；已授权实现时可从 ticket-design 连续进入 implementation。

核对实际加载路径。开发验收可显式读取 repo `.workflow/skills`；安装版从本 Skill 所在安装根找兄弟 Skill，禁止静默混用另一套重名副本。未实现的占位文件不是可调用能力。必要领域依赖不存在时记录缺失路径，不宣称该阶段完成。

已有票据或恢复任务依次读取 **Ticket → source Spec → CONTEXT / ADR / 适用 AGENTS → Implementation Notes → checkpoint**。没有 Ticket 时从用户指定的 Spec / Design Handoff 开始，明确尚不存在的产物。checkpoint 固定为当前 worktree 的 `.local/workflow-state/<ticket>.md`；拆票前使用稳定的 feature 标识，拆票后每票独立，不把其他工作树的 checkpoint 当作当前状态。

遇到恢复、动态值冲突、未知副作用或 session 切换时，先完整执行 [恢复协议](recovery.md)，再选择阶段。完成标准：产物、授权、真实 Git 身份与下一阶段依据齐全。

## 2. 由产物选择下一阶段

checkpoint 的 `phase` 表示**下一步要进行的工作**，不是已经完成的声明。用已确认产物和最新证据校正它，不能只看一个状态字段。

| 当前证据 / 缺口 | phase | 路由及完成产物 |
| --- | --- | --- |
| 需求尚有真正的产品/领域未决项 | discovery | `pair-with-docs` → 已确认 Design Handoff |
| 已有 Design Handoff，缺正式 Spec | spec | `to-spec` → Spec、测试 seam、发布引用 |
| 已有 Spec，缺可执行 Ticket frontier | tickets | `to-tickets` → 票据引用、blocking edges、frontier |
| 当前 Ticket 可开始，缺实现决定 | ticket-design | `ticket-design` → Implementation Notes；frontier 为空直接 ready |
| 已有 Notes，实现/测试尚未完成，或有待修 finding | implementation | `implement`；修复时携带原 finding 及受影响范围 |
| 实现及必要测试已完成，缺对应内容的有效 Review | review | fresh review；见下方兼容边界 |
| Review 已通过且证据仍适用，缺验收 | acceptance | fresh 验收者或 Emilia 从外部事实逐项核对 Ticket |
| 验收已通过，待交接/归档 | closeout | 按仓库 closeout 流程交接；自动化尚未提供时明确留待处理 |

领域 Skill 调用前实际读取文件。新 Owner 产品、安全、架构、数据语义或范围决定才向 Owner 提问；事实查找和已决定事项由 Agent 完成。上游产物缺失时返回最早的必要阶段，明确缺口，保留仍然有效的下游证据。

### WORKFLOW-004 / 005 兼容边界

`review-change` 已实现并可用时把 review 交给它，不在这里复制风险分类规则。尚为占位时，首次 review 使用现有 `code-review`，保留 Standards / Spec 双轴；独立 `implement` 的既有 review/commit 行为保持原样。读取 implement 返回的测试、commit 和 review 证据并补齐 checkpoint，不再次触发已经完成的 full review。finding 修复后的 fresh reviewer 只接收原 finding、修后 diff、相关规范；若需新的风险分级能力则明确 004 依赖，不伪称占位 Skill 已执行。

closeout 按当前仓库已提供的流程执行；005 archive automation 尚不可用时，保留 `phase: closeout`、已完成的验收事实和准确的 next action。不能自动关闭父 Issue、合并 PR、安装全局 Skills，或把本票验收说成整个 v1.1 已完成。

## 3. 在边界保存可恢复产物

使用随包 [checkpoint 模板](checkpoint-template.md)。设计产物写到仓库约定的 handoff / Spec / Ticket，执行状态留在非 Git checkpoint。确认 `.local/` 已被忽略；如未忽略，先为当前仓库建立忽略规则再写，不能把运行状态纳入提交。以 UTF-8 完整替换当前 checkpoint；存在活跃 writer 时先确定所有权，避免两个 session 争写。

只在以下变化后更新：阶段交接、finding 状态变化、acceptance 转换、或影响恢复路径的异常/中断。普通命令、轮询和未改变下一步的证据读取不触发更新。正文保存引用与短结论，不复制完整聊天、逐命令日志或大型 JSONL。

每次交接检查：已确认决定可定位；证据指向具体文件/命令结果和内容身份；finding 有状态；未知/已完成副作用区分；`Next action` 是可直接执行的一步。Ticket-design → implementation 默认延续 session；若上下文重复膨胀、范围失焦，先保存 Notes/checkpoint 再切 fresh implementation session，不依赖自报剩余 token。

Review、focused re-review 默认 fresh sub-agent/session，输入只含 fixed point、目标 diff/内容身份、Ticket/Spec、标准及必要测试证据，不能继承 implementation 聊天。Acceptance 默认 fresh sub-agent/session 或 Emilia 外部核验；只有 continuity 本身是验收目标才复用 session。

## 4. 中断与交接

ChatGPT 审查、客户端断连、网络中断、切换对话属于 external interruption。先按恢复协议查事实；连接中断和 observation wait 窗口结束都不能证明 Codex run 失败或已终止。正常 run 不附加统一 wall-clock timeout；明确 hard deadline 必须是独立且可观察的 run policy。持续产生有效进展就继续观察；无法查清时保留现场与未知状态，不另起会产生重复副作用的 run。

最终交接说明改动、测试、Review/finding 状态、验收级别、Git/PR 和下一步/Owner gate。仅当每个阶段有适用证据时推进；明确区分 source 已实现、fixture 通过、真实链路 accepted、日常 stable。真实 protected apply 必须先给出具体 preview/diff，再取得 Owner 对该计划的明确批准。

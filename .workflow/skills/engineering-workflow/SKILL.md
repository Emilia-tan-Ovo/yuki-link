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
| Review 已通过且证据仍适用，缺验收 | acceptance | **优先由 Emilia 从外部事实逐项核对 Ticket**；只有 criteria 本身要求 Agent/session 行为时才启动 fresh 验收者 |
| 验收已通过，待交接/归档 | closeout | 读取随包 closeout archive 说明，生成摘要并核对证据 |

领域 Skill 调用前实际读取文件。新 Owner 产品、安全、架构、数据语义或范围决定才向 Owner 提问；事实查找和已决定事项由 Agent 完成。上游产物缺失时返回最早的必要阶段，明确缺口，保留仍然有效的下游证据。

### 成本、范围与停止条件

把 **Owner 时间 / 注意力 / 模型额度** 视为和权限、安全同样真实的资源边界。当前 Ticket 默认只为满足其 Ticket / Spec 明确目标和 Acceptance Criteria 工作；不是 blocker 的 drift/recovery、压力测试、额外 fixture、工作流研究或“顺便证明”内容只记录 follow-up，不扩大当前票。

#### Session 生命周期

- `ticket-design` 与 `implementation` **默认使用不同 fresh model session**。设计阶段只负责把实现决定写入 Ticket `Implementation Notes` / repo Notes 与 checkpoint；实现阶段从这些持久化产物、fixed point 与当前 Git 事实恢复，不继承设计聊天。
- implementation prompt 使用“引用 + delta”：Ticket/Notes/checkpoint 路径、fixed point/HEAD、当前授权、必要约束；不得复制完整聊天、完整 Issue/Spec/Notes 或大型日志来补上下文。
- implementation 完成并交给 fresh primary Review 后，原 implementation session 结束。若 Review 产生 finding，修复必须启动 **fresh fix session**，只携带原 finding、Review 报告引用、修复基线、直接受影响文件/规范和最小回归 seam；不得回原 implementation session。
- finding 修复后只允许一次必要的 fresh focused re-review；只有修复引入独立新高风险范围时才由 `review-change` 升级。
- 只有 continuity 本身就是明确验收目标，或 Owner 明确批准的例外，才允许跨阶段复用 model session；checkpoint 必须记录理由。

#### 模型路由

- 默认主力：`gpt-5.6-sol medium`，适用于普通 ticket-design、implementation、finding fix、focused review。
- 复杂跨模块实现、复杂调试或 full review 可使用 `gpt-5.6-sol high`。
- `gpt-6-astra` 只用于最困难的并发/一致性/安全/跨系统疑难问题，或已有事实证明 Sol high 不足的任务；**每次启动 Astra 前必须向 Owner 说明升级理由并取得明确批准**。
- `gpt-5.6-luna` 与 `gpt-5.6-terra` 禁止使用。其他未列模型只有 Owner 明确改变策略后才可使用。
- `xhigh/max/ultra` 默认禁止；任何模型使用这些档位前都必须取得 Owner 明确批准。
- 不因“这张票重要”自动使用高成本模型；模型选择按**当前阶段当前问题**的难度决定。

#### 0-token 环境 preflight

任何 fresh worktree 或 fresh model session 在启动模型前，Emilia 先用 YCA 确定性核对：

1. Git fixed point / branch / worktree 身份；
2. 项目依赖是否就绪（例如 package lock 对应的 `node_modules` / 构建依赖）；新 worktree 不假设自动继承依赖，缺失时先准备或复用项目既有依赖缓存；
3. 当前任务真正需要的宿主工具是否存在；不存在的可选工具直接选择已知 fallback，不让模型先撞一次错误；
4. GitHub/外部系统动作的认证 source of truth；默认由 Emilia + YCA direct 执行机械写入，不让模型用额度试认证；
5. 预计超过短同步窗口的命令改走 owned task；测试/日志仍由 YCA 保存原始输出，模型只收摘要/失败切片；
6. 下一 model session 的模型/reasoning、权限默认与 `model_usage` anomaly 状态。

Preflight 失败时先修环境或记录 blocker，**不得启动模型来诊断一个确定性工具已经能发现的问题**。

#### 权限与 Agent Adapter

- Workflow 不自行收紧 Owner 已选择的原生 Agent 权限。当前 Codex/YCA 已支持在 session 创建时解析并冻结本机默认权限；普通仓库工程 session **默认省略显式 `permissions`**，让 YCA 继承 Owner 的有效本机默认（当前为 `danger-full-access + on-request`）。
- 若调用方必须显式指定权限，只能使用 Owner 已确认的等价模式；没有 Owner 明确要求，不得把 `danger-full-access` 降成 `workspace-write` / `read-only`。权限在 session 创建时冻结，发现创建错模式时不得在旧 session 上假装修复；停止该 session，保存事实，从 fresh session 用正确权限继续。
- Full Access 不等于无限业务授权。模型仍必须遵守 Ticket scope、Owner gate、不可逆操作与 deployment/merge 边界；使用行为约束替代破坏环境一致性的隐式沙箱降级。
- 后续接入其他 Repository Engineer（包括 DeepSeek Agent）时，adapter 必须提供与本 workflow 等价的：权限 source of truth/冻结、durable run/session、usage/模型身份、side-effect 证据与恢复语义。缺失这些能力时只能标记为部分兼容，不能静默跳过规则。

#### 并发与机械工作

- 默认最多一条活跃 Codex 模型工作线。第二条模型线只有在能明确缩短关键路径且 Owner 明确批准后才能启动；“允许并发”只是上限，不是默认配置。
- Git/status/diff、hash、checkpoint/closeout、GitHub Issue/PR/merge/close、full suite 执行、日志筛选/压缩等由 Emilia + YCA 确定性完成，不为方便启动模型。
- 实现模型只运行直接驱动当前红→绿所需的最小定向测试与必要 typecheck；完整测试套件默认由 YCA 执行。若 full suite 失败，只把计数、退出码、失败 case 与必要上下文切片交给模型。
- 大型日志、Git history、runtime JSONL、完整测试输出和长文件先经确定性工具筛选/压缩；fresh session 只接收结构化摘要、失败切片和来源引用。

#### 成本预算与熔断

以下 raw input token 只作为工程诊断预算，不等同于产品额度 1:1 计费：

- ticket-design 目标 ≤ 1.5M；
- implementation 目标 ≤ 3M；
- primary Review 目标 ≤ 2M；
- finding fix 目标 ≤ 1M；
- focused re-review 目标 ≤ 0.7M；
- 普通 Ticket 累计目标 ≤ 6M。

每个模型 run 到达终态后，Emilia 从 YCA durable run status 读取并累加 input / cached input / output / model / reasoning / run 数到 checkpoint `model_usage`；无法取得时记 unknown，不能用模型自述代替。**启动任何下一次模型 run 前必须先检查该字段。**

- 任一单 run input > 3M，或整票累计 input > 6M：标记 `cost anomaly`，立即停止扩展；先向 Owner 简短说明烧在何处、为什么现有证据仍不足、接下来如何收缩。在 anomaly 解除前不得启动新的模型 run。
- 整票累计 input 明显高于目标时继续保持 `cost anomaly`；允许复杂大票合理超标，但下一次模型调用前必须说明继续的必要性、预期收益与收缩方案，不以固定数字机械禁止推进。
- cached input 单独记录，用来发现“肥 session 反复搬运上下文”；不得把 cached token 占比高解释成“所以成本没问题”。

Acceptance **优先由 Emilia 使用确定性外部事实直接逐条核对 Ticket**。只有 Acceptance Criteria 本身要求观察 Agent 路由、session/thread continuity 或其他模型行为时，才启动额外 fresh acceptance agent；普通 Ticket 不为“证明工作流本身”生成场景矩阵。

Owner 明确表达“收尾”“别扩范围”“我要休息/睡觉”或等价意图时，立即进入 **stop-expansion**：禁止新增 scope、fixture、测试矩阵、reviewer、模型升级和旁支调查；只允许处理当前 blocker、保存 checkpoint、完成必要 closeout。外部平台中断仍按恢复协议查 durable run/session/checkpoint，不因为 UI 静默或观察超时重启一套任务。

对 Owner 的过程更新默认只回答三件事：**现在在做什么、为什么这是当前票必须的、还剩什么**。内部 digest、fixture、cursor、isolation 等低层细节只在 Owner 主动询问或确实影响决策时展开。

### Review policy 与 closeout

本 workflow 调用 implement 时显式传递 `review_policy: delegated`、接收 handoff 的上层、Ticket/Spec、fixed point 与授权终点。先读取同根 implement 及其 handoff 约定；仅有本 Skill 文件或旧 checkpoint 不构成 policy，独立 implement 保留默认完整 code-review。

implement 返回持久化 Implementation Handoff 后，核对测试、实际 commit、未提交范围和内容身份，保存 `phase: review`。当前 implementation context 不执行审查；从外部创建无历史 reviewer，显式给出 handoff、fixed point/目标内容、Ticket/Spec、规范和必要测试结果，实际读取同根 `review-change/SKILL.md`。若调用者保留 reviewer 启动权，到此交接停止。依赖缺失/不可用则保持 review 待办，不能静默改用其他安装根或宣称已通过。

风险分类只由 review-change 定义。接收其报告后核对受审内容仍适用及 finding 状态：有待修 finding → **fresh fix implementation session**（只携带原 finding、修复基线和受影响范围）；缺轴/漂移 → 补必要审查；有效通过 → acceptance。已有充分证据时不重复 full review。finding 修复后 fresh 定向复核，出现新风险时由 review-change 升级；始终保留原 Standards / Spec 两轴结论。

进入 closeout 时读取 [归档输入与生成协议](closeout-archive.md)，用同根 `scripts/closeout-archive.mjs` 从精简本地输入生成 `.workflow/history/<ticket>.md`。先保存本机 evidence 观察快照，再确定性生成；Emilia 提交前回读摘要，对照实际来源做 evidence consistency 检查。完成标准是必要字段及来源齐全、缺失/过期/未知已标明、raw 留本机、归档可独立理解；生成成功本身不证明验收通过。PR/merge 等尚未发生时保留 pending/unknown，后续有回执再补记；checkpoint 保存剩余动作和授权边界。不能自动关闭父 Issue、合并 PR、安装全局 Skills，或把本票验收说成整个 v1.1 已完成。

## 3. 在边界保存可恢复产物

使用随包 [checkpoint 模板](checkpoint-template.md)。设计产物写到仓库约定的 handoff / Spec / Ticket，执行状态留在非 Git checkpoint。确认 `.local/` 已被忽略；如未忽略，先为当前仓库建立忽略规则再写，不能把运行状态纳入提交。以 UTF-8 完整替换当前 checkpoint；存在活跃 writer 时先确定所有权，避免两个 session 争写。

只在以下变化后更新：阶段交接、finding 状态变化、acceptance 转换、影响恢复路径的异常/中断，**以及每个模型 run 终态后更新 `model_usage`**。普通命令、轮询和未改变下一步的证据读取不触发其他正文更新。正文保存引用与短结论，不复制完整聊天、逐命令日志或大型 JSONL。

每次交接检查：已确认决定可定位；证据指向具体文件/命令结果和内容身份；finding 有状态；未知/已完成副作用区分；`Next action` 是可直接执行的一步。Ticket-design → implementation **默认 fresh**：先保存并回读 Notes/checkpoint，再由 fresh implementation session 从持久化事实继续。Review finding → fix 同样默认 fresh。checkpoint 同时保存最新 `model_usage` 与 anomaly 状态。

若当前 YCA 已登记 Harness Ticket 且公开提供 `harness_record_workflow`，在阶段交接、finding 状态变化、Acceptance 转换或恢复异常完成本地产物与外部事实核对后，由 Emilia 提交一次完整结构化快照，并保存成功回执中的 revision/event_id/cursor；首次 expected_revision 为 null，后续使用最近成功 revision。冲突时先读取最新记录协调，不覆盖；记录失败不把阶段误报为已保存，也不重放工程动作。未启用 Harness 的独立 Workflow 保持原 checkpoint 约定，不把该入口当成新的执行、Review 或 Acceptance Agent。

Review、focused re-review 默认 fresh sub-agent/session，输入只含 fixed point、目标 diff/内容身份、Ticket/Spec、标准及必要测试证据，不能继承 implementation 聊天。Acceptance 默认由 Emilia 使用外部事实直接核验；只有验收 criteria 本身要求 Agent 路由、session/thread continuity 或其他模型行为时才启动 fresh acceptance agent，且不为普通 Ticket 额外构造验收矩阵。

## 4. 中断与交接

ChatGPT 审查、客户端断连、网络中断、切换对话属于 external interruption。先按恢复协议查事实；连接中断和 observation wait 窗口结束都不能证明 Codex run 失败或已终止。正常 run 不附加统一 wall-clock timeout；明确 hard deadline 必须是独立且可观察的 run policy。持续产生有效进展就继续观察；无法查清时保留现场与未知状态，不另起会产生重复副作用的 run。

最终交接说明改动、测试、Review/finding 状态、验收级别、Git/PR 和下一步/Owner gate。仅当每个阶段有适用证据时推进；明确区分 source 已实现、fixture 通过、真实链路 accepted、日常 stable。真实 protected apply 必须先给出具体 preview/diff，再取得 Owner 对该计划的明确批准。

# Emilia × Sylvia Workflow v1.1 — 已确认决策

> **Status:** Confirmed design decisions, not yet applied to global Skills/AGENTS.
>
> 这份文件是 Workflow v1.1 当前阶段的**决策 source of truth**。详细背景与完整生命周期见 `emilia-sylvia-workflow-v1.1.md`；checkpoint 细节见 `workflow-context-checkpoint.md`；Skill 改造草案见 `workflow-v1.1-skill-plan.md`。
>
> 在正式修改全局 `~/.agents/skills`、项目 `AGENTS.md` 或 YCA 生产代码前，以本文件判断“哪些已经和桓宇确认”。

## 1. 总体目标

保留现有主流程：

```text
pair-with-docs
    ↓
to-spec
    ↓
to-tickets
    ↓
ticket-design
    ↓
implement
    ↓
review
    ↓
acceptance
    ↓
closeout
```

v1.1 不推翻 matt skills，而是解决真实协作中出现的：

- 桓宇被拉回当流程管理员/传话筒；
- implementation 与 review 上下文混在一起；
- review 过重、focused finding 也重复全量审查；
- 大日志/历史直接交给模型全量扫描导致超时和上下文膨胀；
- Agent 上下文不可见、不可预测，恢复工作依赖“模型还记得”；
- resident 验收与模型自述没有严格分开；
- Issue 完成后过程数据散落，长期复盘困难；
- YCA 等待 Codex 时存在重复 status/output 轮询；
- ChatGPT/客户端等外部平台可能在任意阶段触发审查、断连或中断，当前恢复不能依赖模型仍记得中断前状态。

## 2. 三人职责

### 桓宇 — Owner / 决策者 / 最终体验判断

- 决定产品目标、用户可见行为、重大架构/安全/数据语义取舍；
- 不负责查代码、查版本、查配置等可由 Agent 自己取得的事实；
- implement 开始后原则上退出日常执行；
- 只有遇到需求冲突、权限扩大、不可逆操作、架构方向变化或 scope 扩大时重新介入；
- 不再承担 Emilia ↔ Sylvia 的人工传话。

### Emilia — Orchestrator / Teacher / Quality Gate

- 主持需求与设计阶段；
- 自己通过 YCA、Git、文件、Context7、Sylvia 调查客观事实；
- 在用户不理解技术概念时先教学，再请求决定；
- 管理 worktree、session 生命周期、review 路由、checkpoint、resident acceptance 和 GitHub closeout；
- 优先用 filesystem/Git/command/tool event 等外部事实验证结果；
- 不和 Sylvia 抢 implementation 代码执行职责。

### Sylvia — Repository Engineer

- 深入仓库调查；
- 使用 Skills / Context7；
- 进行 ticket-design 代码级调查；
- 使用 TDD 实现、测试、typecheck、commit；
- 在独立 reviewer session 中承担受控 Review；
- 不替桓宇做产品决策；
- 不把模型自述当验收事实。

## 3. 时间规则：不用统一硬时长，改为“进展预算”

之前讨论过的 30～60 秒、60～90 秒、180 秒来自现有 YCA run 统计，只保留为经验背景，**不写成硬规范**。

正式规则：

- 任务只要仍持续产生新证据、新命令结果、新测试结果或明确推进，就可以继续；
- 重复等待、长期无新事件、读取范围持续膨胀、明显偏离原目标时，Emilia 应缩小范围、停止当前 run、改为结构化提取或重新启动更小任务；
- 用户明确要求的长任务，不因为超过固定时间自动判异常；
- 判断重点是“是否还在有效推进”，不是钟表时间。

## 4. 上下文原则：把关键状态外置，不解决“还剩多少 token”

我们不依赖模型能看到上下文剩余量。

目标改成：

> 即使 Emilia / Sylvia 的当前上下文立刻清空，fresh session 也能从外部状态恢复正确工作。

信息分层：

| 信息 | Source of truth | 性质 |
| --- | --- | --- |
| 稳定工程规则 | `AGENTS.md` | 低动态 |
| 领域语言 | `CONTEXT.md` | 低动态 |
| 难以逆转的架构决定 | ADR | 低动态 |
| 产品需求 | Spec / Ticket | 中动态 |
| 实现级已确认决定 | Ticket `Implementation Notes` | 中动态 |
| 当前执行状态 | `.local/workflow-state/<ticket>.md` | 高动态 |
| 原始事实 | Git / YCA runtime / tests / tool events | 高动态 |
| 完成后的长期摘要 | `.workflow/history/<ticket>.md` | 冻结 |

模型上下文是缓存，不是唯一状态存储。

## 5. Checkpoint 格式与位置

### 已确认格式

每张活跃 ticket 一个：

```text
.local/workflow-state/<ticket>.md
```

不进 Git。

文件格式：

- YAML Front Matter：结构化、高频机器字段；
- Markdown Body：决策、证据、finding、next action 等语义内容。

推荐结构：

```markdown
---
ticket: YCA-008
phase: review
worktree: ...
branch: ...
fixed_point: ...
head: ...
implementation_session: ...
updated_at: ...
---

# Confirmed decisions
...

# Current evidence
...

# Open findings / blockers
...

# Next action
...
```

### 写入时机

只在阶段边界或恢复路径真正发生变化时写，不记录每条命令：

1. ticket-design → implement；
2. implement 完成 / commit → review；
3. review 产生 finding；
4. finding 修复 → focused re-review；
5. review cleared → acceptance；
6. acceptance → closeout；
7. 异常/中断会导致 fresh session 不知道怎么继续时。

### 恢复协议

fresh session 恢复一张票时：

1. Ticket；
2. source Spec；
3. CONTEXT / ADR / AGENTS；
4. Implementation Notes；
5. workflow checkpoint；
6. 用 Git/YCA 验证关键动态状态仍成立；
7. 从 `Next action` 继续。

Checkpoint 是导航，不替代 Git/YCA 事实。

## 4.1 外部平台中断韧性

- ChatGPT 侧审查、客户端断连、网络中断或对话切换都视为 **external interruption**，不得自动归因于项目、YCA 或 Codex 失败。
- 一旦中断会让 fresh session 无法确定当前 phase / diff / run / next action，应立即更新 checkpoint；不要求每次工具调用都写状态。
- 恢复后先读取 checkpoint，再用 Git/YCA/runtime/tests 重新验证易变化事实，最后从 `Next action` 继续；不得仅依赖模型回忆。
- 如果中断发生在 implementation 期间，恢复应优先复用仍可用的 implementation session；若不可复用，则以 Implementation Notes + checkpoint 启动 fresh implementation session。
- 如果中断发生在 review/acceptance 边界，不重复已经有充分证据完成的阶段；例如已完成 fresh review 后只恢复 acceptance。
- Workflow v1.1 的最终 fixture 必须包含至少一次人为 external interruption，证明中断前后不会重复副作用、重新做已完成阶段或丢失 finding/next action。

## 6. Closeout Archive

### 已确认位置

长期轻量摘要进入 Git：

```text
.workflow/history/<ticket>.md
```

原始日志继续留：

- YCA runtime；
- `.local`；
- 其他本机原始 JSONL。

不把完整 JSONL、大型日志提交 Git。

### 最低记录内容

- Issue / ticket；
- worktree / branch；
- implementation session / run；
- review session / run；
- model / reasoning；
- 代表性耗时 / 调用次数；
- 失败 / 重试；
- findings 与修复；
- PR / merge commit；
- 人工介入点；
- 原始 run/log 路径。

目的：fresh clone / 新电脑 / fresh Agent 仍能恢复“这张票发生过什么”。

## 7. Session 生命周期

核心原则：

> 需要连续认知的工作复用 session；需要独立判断的工作使用 fresh session。

### Project Design Session

```text
pair-with-docs
→ to-spec
→ to-tickets
```

允许连续。

但不能依赖连续；阶段产物必须足够恢复。

### Ticket Implementation Session

```text
ticket-design
→ implement
```

默认允许复用。

原因：ticket-design 刚刚建立的代码 seam、precedent、测试位置等属于有价值实现上下文。

如果 ticket-design 已经异常膨胀，可以由 Emilia 主动切 fresh implementation session，并通过 checkpoint/Implementation Notes 恢复。

### Review Session

**默认必须 fresh。**

Reviewer 只应看到必要显式证据：

- fixed point；
- diff；
- Ticket / Spec；
- AGENTS / standards；
- 必要测试结果。

不能把 implementation session 的长历史作为隐式证据。

### Focused Re-review

**默认 fresh。**

只携带：

- 原 finding；
- 修后 diff；
- 相关规范/验收要求。

不重新跑整张票的 full review。

### Acceptance

**默认 fresh 或由 Emilia 直接从外部验收。**

优先由 Emilia 使用：

- filesystem；
- git；
- PowerShell；
- HTTP；
- YCA events；
- run status/output；

进行 ground-truth 核对。

只有当“同一 session/thread continuity 本身就是验收目标”时才刻意复用 session（例如 YCA-006）。

## 8. 新增 `engineering-workflow` 上层 Skill

**确认新增。**

它是 workflow/router，不替代领域 Skill。

职责：

- 判断当前 phase；
- 决定下一步调用哪个 Skill；
- 管理 checkpoint；
- 管理 implementation/review/acceptance session 生命周期；
- 调用 review router；
- 识别什么时候必须重新找桓宇决策；
- closeout 时生成 archive；
- 保证阶段产物足够 fresh session 恢复。

现有 Skill 保持单一职责。

## 9. 新增 `review-change` Review Router

**确认新增。**

不把现有 `code-review` 越改越胖。

### full

适用于：

- 权限 / 安全；
- 并发；
- 持久化；
- 数据/schema/迁移；
- 外部 API / 重要契约；
- 架构边界；
- 广泛生产代码；
- 用户显式要求完整 review。

动作：fresh session 调用现有完整 `code-review`。

### focused

适用于：

- 局部 bug fix；
- 已知 finding 的修复；
- 小范围明确行为变化。

只输入具体风险/finding + 相关 diff + 必要规范。

### evidence

适用于：

- docs-only；
- acceptance 记录；
- closeout；
- 不改变生产行为的元数据更新。

动作：

- `git diff --check`；
- evidence consistency；
- 发现实际风险时升级 focused/full。

任何情况下 Emilia 都可以根据真实 diff 升级 review；不得为了省 token 降级明显高风险改动。

## 10. 现有 Skills 的拟议修改

这些是**已确认方向，但尚未写入全局 Skill 安装目录**。

### pair-with-docs

保留现有行为。

增加：

- 阶段结束生成可恢复 Design Handoff；
- Handoff 记录 confirmed decisions / unresolved / next step；
- 动态 session/run 状态不写入 CONTEXT。

### to-spec

保留“不要重新采访用户”。

增加：

- 优先读取 Design Handoff + CONTEXT/ADR，而不是依赖完整聊天仍在上下文；
- testing seam 确认后形成可恢复 handoff；
- 发布后 workflow phase → tickets。

### to-tickets

保留 vertical slice / blocking edges。

增加：

- 可为 ticket 记录初始 risk hint（low/normal/high），只作为 review routing hint；
- 最终 review 模式仍以实际 diff/risk 为准；
- checkpoint 只记录 frontier，不复制 ticket 正文。

### ticket-design

保留 implementation frontier。

增加：

- 调查后 frontier 为空时可以直接生成 Implementation Notes，不强制制造用户问题；
- handoff checkpoint 记录 fixed point、worktree、decisions、deferred details、next action；
- 不自动 invoke implement。

### implement

当前现状：写死“完成后 use /code-review”。

v1.1 方向：

1. 保留 TDD、定向测试、typecheck、full suite、commit；
2. 完成后输出 Implementation Handoff：
   - fixed point / HEAD；
   - changed scope；
   - tests；
   - known risks；
   - commit；
3. 若存在上层 workflow review policy → 交给 `review-change`；
4. 若没有上层 policy → 向后兼容，默认继续调用完整 `code-review`。

### code-review

保留完整 Standards + Spec 双轴语义。

优化：

- reviewer 默认 fresh；
- implementation session 历史不能作为隐式 evidence；
- finding 修复后交给 focused review，而不是默认再次 full review。

## 11. 大数据处理原则

日志、Git history、大型测试输出、YCA runtime JSONL：

```text
raw data
  ↓
deterministic extractor
  ↓
compact JSON / table
  ↓
LLM analysis
```

不默认让模型遍历数百文件后再总结。

这条来自真实复盘：整库历史提取让 Sylvia 超时，而 PowerShell 先结构化后分析可以快速得到结果。

## 12. Emilia 的验收原则

优先 ground truth：

- 文件真的变了；
- Git diff 真的存在；
- exit code 真的为 0；
- MCP 真的产生 `mcp_tool_call`；
- command 真的产生 `command_execution`；
- thread/session 真的相同；
- test suite 真的通过。

“模型说成功”不能代替验收。

语义判断才交给 reviewer：

- 是否符合 Spec；
- 设计是否合理；
- standards / code smell；
- scope creep。

## 13. 已确认的小型工程增强候选

这些还没有进入正式 ticket：

### Codex run 等待 / long-poll / execution timeout

已确认当前 YCA 的 `SessionManager` 使用 wall-clock `timeout_ms` 控制 Codex run；若调用方未指定，当前默认值为 300000 ms。调用方可显式提供 1000～1800000 ms。计时器到期会直接请求停止 run，并以 `RUN_TIMEOUT` / `timed_out` 结束；**当前实现不会因为 run 持续产生新事件而刷新该 deadline**。

本轮 Workflow v1.1 设计中曾多次显式传入 180000 ms，因此出现“仍在正常调查/Review 的 Sylvia 在 180 秒被 YCA 主动停止”的真实案例。这不是 observation polling timeout，也不是 ChatGPT UI timeout。

v1.1 首批交付必须同时解决两个问题：

1. **Observation wait**：减少
   `get_status → sleep → get_status → get_output`
   的重复轮询，等待“新事件 / run terminal / observation window elapsed”任一条件后返回。
2. **Execution lifetime**：observation window elapsed 不得停止 run；Workflow 不得为了方便轮询给正常 Agent 工作统一附加短 wall-clock execution timeout。真正的 hard execution deadline 必须是独立、明确、可观察的 run policy。

在正式修复前，长 Agent run 只能通过更宽松的显式 timeout 作为临时缓解；这不是最终解决方案。

具体采用扩展现有 status/output、新增 wait seam、可续期 deadline、无默认 hard deadline或其他实现，由 001 ticket-design 决定。

**优先级：001，先于其他重型 Workflow 实现执行。**

### Workflow closeout archive 自动化

优先先做 repo-local script / Skill。

先证明 archive 格式长期有价值，再决定是否进入正式 YCA MCP tool。

## 14. 当前不作为主阻塞的问题

- Control Center/Supervisor 登录后可自启，但 `autoRecovery=false` 时 YCA/tunnel 仍需人工“启动全部”；
- Context7 `type` 字段 warning 当前不阻塞真实 MCP 调用；
- Codex Desktop executable hash 会变化，新脚本禁止硬编码 hash；
- ChatGPT 自定义插件 schema 不实时刷新属于客户端外部摩擦。

## 15. 当前未应用的变更边界

目前只是本地 Workflow v1.1 设计持久化：

- **没有修改全局 `~/.agents/skills`；**
- **没有修改项目受保护 `AGENTS.md`；**
- **没有新增生产 YCA 工具；**
- **没有 commit / push 本工作流分支。**

后续只有在桓宇确认后，才进入 `to-spec → to-tickets → implement`，正式修改 Skills/规则或增加工程能力。

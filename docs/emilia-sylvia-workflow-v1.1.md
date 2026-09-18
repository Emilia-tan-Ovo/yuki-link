# Emilia × Sylvia Workflow v1.1（优化路线草稿）

> **状态：Draft。** 当前已确认的设计决策统一以 [`workflow-v1.1-decisions.md`](./workflow-v1.1-decisions.md) 为 source of truth；本文件保留完整背景、生命周期和讨论脉络。

## 目标

在不改变 `pair-with-docs → to-spec → to-tickets → ticket-design → implement → code-review` 主流程的前提下，减少人工传话、重复调查、无效轮询、超重 review 和难以追溯的收尾记录，让桓宇主要参与真正需要人的产品/架构决策，让 Emilia 负责编排、证据核对与质量门禁，让 Sylvia 负责仓库内的设计调查、实现、测试和受控 Review。

## v1.1 已确认优化方向

### 1. 时间预算改为“进展预算”，不设统一死时间

先前 30～60 秒、60～90 秒、180 秒等数字来自现有 run 的经验统计，只能作为观察线索，不作为硬规范。不同任务复杂度差异很大。

默认判断标准改为：

- 任务仍持续产生新证据、命令、测试结果或明确推进行为时，可以继续等待；
- 长时间没有新事件、只重复等待、范围不断膨胀、开始读取明显无关资料或已经偏离原目标时，Emilia 应考虑缩小范围、停止当前 run、改为结构化数据提取或启动更小的新 session；
- 对用户明确要求的长任务，不因超过某个固定秒数自动判为异常。

### 2. Implementation Session 与 Review Session 分离

- 一张小票的设计与实现可以保持连续 implementation session，让 Sylvia 保留局部代码上下文；
- 独立 Review 默认使用新的 reviewer session，只提供 fixed point、diff、Issue/Spec、适用标准和必要证据；
- 修复 finding 后使用 focused re-review，只携带原 finding 和修后 diff，不把整个实现 session 的长历史继续背入；
- 需要验证“同一 session/thread 继承”的票据除外，该需求本身就是验收对象。

### 3. Review 分级

- 高风险生产改动（权限、并发、持久化、外部契约、架构边界、大范围代码修改）：完整 Standards + Spec 双轴 Review；
- 局部 bug fix / 小范围生产变更：focused review，围绕具体风险和原 finding；
- docs-only、验收记录、closeout：默认使用 diff-check + evidence consistency review；只有证据冲突或规范影响才升级完整双轴。

Skill `code-review` 的正式行为不被改写；这里规定的是“什么时候值得调用完整 code-review”。

> **待落地冲突：** 当前本机 `implement` Skill 明确要求实现完成后调用 `/code-review`。因此“Review 分级”目前只是 v1.1 Proposal；正式采用前需要修改/扩展现有 Skill，或增加更高层 workflow Skill 负责选择完整双轴与 focused review，不能靠口头约定静默绕过现行 Skill。

### 4. 大数据先确定性提取，再交给模型分析

日志、Git history、大型测试输出、runtime JSONL 等先由 PowerShell/脚本做确定性筛选与压缩，再把紧凑结构化结果交给 Emilia/Sylvia 分析。

避免让模型自行遍历数百文件后再总结，减少超时、上下文膨胀和无关读取。

### 5. Emilia 的验收职责以事实核对为主

优先使用 YCA 的 `filesystem_*`、`git_*`、`powershell_*`、`codex_get_status/output` 独立核对：

- 文件是否真的改变；
- Git diff 是否符合预期；
- 测试/命令真实退出码；
- run 是否终态；
- MCP/Skill 是否出现真实工具事件；
- session/thread 是否真正复用。

只有“实现是否符合 Spec、设计是否合理、是否存在代码质量问题”这类语义判断，再调用独立 reviewer。

### 6. Issue Closeout 自动生成轻量开发记录

不把完整 runtime JSONL 提交 Git。每张票关闭时生成轻量摘要，至少记录：

- Issue / ticket / worktree / branch；
- implementation session/run；
- review session/run；
- 模型与 reasoning；
- 代表性耗时和调用次数；
- 失败/重试；
- review findings 与修复；
- PR / merge commit；
- 人工介入点；
- 原始 run/log 路径。

原始 JSONL 保留为本机追溯证据，摘要用于长期复盘。

## 后续小型工程增强候选

### Codex wait / long-poll

减少 Emilia 为等待 Sylvia 而不断 `get_status → sleep → get_output` 的轮询。

期望方向：允许调用方等待“新事件 / 终态 / 最长等待窗口”之一发生后返回。具体 API 设计需后续单独设计，不在本草稿直接确定字段。

### Workflow closeout archive

优先考虑 repo-local script / Skill，而不是立刻新增 MCP 工具。先证明摘要格式有持续价值，再决定是否进入 YCA 正式工具面。

## 便利性问题（非当前主阻塞）

- Control Center/Supervisor 可登录自启，但 `autoRecovery=false` 时 YCA/tunnel 登录后仍需人工“启动全部”；后续如需要真正随开机可用，再单独处理。
- 当前 Codex 对 `mcp_servers.context7.type` 给出 ignored warning，但 Context7 已真实调用成功；不为此单独修改用户全局配置。
- Codex Desktop executable hash 会变化；任何新脚本不得固定 hash 路径，应依赖动态发现。
- ChatGPT 自定义插件 schema 刷新仍可能需要重连/重装，这是客户端外部摩擦，不通过频繁新增工具规避。

## 完整协作生命周期

### A. 新项目设计：pair-with-docs

**桓宇**
- 提出项目目标、真实需求、限制、个人偏好；
- 对产品行为、重要架构取舍和不可逆决策拥有最终决定权；
- 不负责查代码、环境、版本事实，也不承担“传话筒”。

**Emilia**
- 主持 pair-with-docs；
- 一次只推进一个高杠杆决策；
- 自己通过工具、仓库、Context7、Sylvia 调查可客观查到的事实；
- 桓宇不熟悉概念时先教学、画流程/层次，再请求决定；
- 把模型提出的新行为规则标为 Proposal，等待桓宇确认；
- 维护 CONTEXT.md / 必要 ADR；
- 判断设计树什么时候已经足够进入 to-spec。

**Sylvia**
- 作为代码库调查与技术事实代理；
- 可被 Emilia 要求只读扫描现有实现、相邻模式、测试 seam、框架限制、外部文档；
- 不代替桓宇做产品决策；
- 不在 pair-with-docs 阶段提前实现业务代码。

### B. to-spec

**桓宇**
- 只确认关键测试 seam 是否符合预期；不重新接受一轮需求访谈。

**Emilia**
- 综合 pair-with-docs 已确认内容、CONTEXT/ADR、代码事实；
- 与 Sylvia 调查现有最高测试 seam，尽量复用而不是新增；
- 生成并发布 Problem / Solution / User Stories / Implementation Decisions / Testing Decisions / Out of Scope；
- 保证 Spec 只写已确认决定，不把 Proposal 偷偷变成需求。

**Sylvia**
- 补充代码库与测试结构事实；
- 检查 Spec 中技术描述是否和真实项目形态冲突；
- 不扩展产品范围。

### C. to-tickets

**桓宇**
- 判断票据颗粒度是否舒服；
- 确认阻塞关系；
- 决定哪些票合并/拆分。

**Emilia**
- 把 Spec 切成 tracer-bullet vertical slices；
- 每张票都必须能独立 demo / 验证并适合单个 fresh context；
- 标出 Blocked by；
- 需要时让 Sylvia 查 prefactor / blast radius；
- 得到桓宇确认后发布 Issues。

**Sylvia**
- 调查代码依赖与真实 blocking edges；
- 帮助发现“看似独立、实际必须先做”的技术前置；
- 不自行改变票据范围。

### D. 每张票：ticket-design（按需）

**桓宇**
- 只参与真正会改变实现方向的选择；
- 可以先给自己的直觉设计；
- 不懂时由 Emilia/Sylvia 先讲清，而不是被迫猜答案。

**Emilia**
- 判断该票是否真的需要 ticket-design；
- 读取 ticket/spec/CONTEXT/ADR/AGENTS；
- 让 Sylvia 扫当前代码、配置、测试和邻近 precedent；
- 维护 implementation frontier，只把高杠杆未决问题拿给桓宇；
- 达到“足够实现”后，把 decision-rich 内容写入 Implementation Notes。

**Sylvia**
- 深入代码级调查；
- 给出模块 seam、接口、测试点、现有 precedent 和风险事实；
- 在桓宇确认前把新设计保持为 Proposal；
- 不在 ticket-design 阶段提前实现。

### E. implement

**桓宇**
- 明确授权开始实现后原则上退出日常执行；
- 只有遇到需求冲突、权限扩大、破坏性/不可逆选择、票据范围需要扩大时再介入。

**Emilia**
- 为该票建立/选择隔离 worktree；
- 将已确认 ticket + Implementation Notes +边界交给 Sylvia；
- 监控进展但不微管理；
- 对长输出先做结构化提取；
- 出现环境故障时区分“项目代码问题 / YCA 问题 / Codex 上游问题 / ChatGPT UI 问题”。

**Sylvia**
- 使用 implement/TDD；
- 在预先约定 seam 写测试；
- 小步实现并经常跑定向测试/typecheck；
- 最后跑完整测试；
- commit 当前分支；
- 对高风险生产改动按策略执行完整 code-review；低风险票按 v1.1 Review 分级执行。

### F. Review / Fix

**完整 Review 时**
- 新开独立 reviewer session；
- Standards 轴只看 repo standards + smell baseline；
- Spec 轴只看票据/Spec 和 diff；
- 两轴独立，不互相污染。

**Emilia**
- 固定 review fixed point；
- 控制 reviewer 输入为必要最小集合；
- 独立验证 findings 是否有事实基础；
- finding 修复后只做 focused re-review；
- 避免“为了确认无问题”无限启动新的 reviewer。

**Sylvia**
- implementation session 负责按 finding 修复；
- reviewer session 不直接改代码；
- focused reviewer 只确认原 finding 是否关闭。

**桓宇**
- 普通 review finding 不需要逐条当项目经理；
- 只有 finding 暴露出新的产品/架构取舍或需要扩大范围时才回到决策位置。

### G. Resident / User-visible Acceptance 与 Closeout

**Emilia**
- 通过当前 ChatGPT → resident YCA → Sylvia / PowerShell / Git 的真实公开边界验收；
- 用外部文件/Git/exit code/tool event 证明，不接受“模型说成功了”；
- 更新 ticket acceptance、PR、Issue；
- 生成 closeout archive 摘要。

**Sylvia**
- 在必要时执行真实验收任务；
- 返回可观察工具事件和结果；
- 不把一次通过描述成长期稳定。

**桓宇**
- 一般只看最后的人类可读结论；
- 对真正涉及体验/产品行为的验收做最终判断；
- 不再承担跨 Agent 的手工传话。

## 核心职责一句话

- **桓宇：Owner / 决策者 / 最终体验判断。**
- **Emilia：Orchestrator / 教练 / 事实核验 / 质量门禁 / GitHub 收尾。**
- **Sylvia：Repository Engineer / 实现者 / 测试者 / 技术调查者 / 受控 Reviewer。**

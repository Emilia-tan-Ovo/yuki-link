# HARNESS-007 · Implementation Notes

## 来源与边界

- Ticket：`.local/HARNESS-007-ticket.md`；Fixed point：`b1e19f4e34b46306f342e42ba19adcc80809d6d7`；branch：`codex/yuki-harness-v0-007`。
- 产品语义：`docs/specs/yuki-harness-v0.md` 第 71–90、94–108 行；设计来源：`docs/design/yuki-harness-v0-handoff.md` 的“工程任务归属”“Change View”“Conversation 模型”“测试 Seam”。
- 本票只交付 Ticket detail 的累计 Changes、事实刷新及 run / commit 下钻；不扩展 Workflow、Review、Acceptance、服务管理或 HARNESS-008+。

## Implementation Decisions

### 1. 固定比较身份是 Ticket 的不可变持久事实

- `harness_register_ticket` 增加可选的 `fixed_point`。有 `expected_worktree + fixed_point` 时，登记前通过真实 Git 将 fixed point 解析为完整 commit OID，并同时取得 canonical worktree root 与 canonical `git-common-dir`。持久化的比较身份至少包含：`repository_id`（本机 canonical git-common-dir）、`worktree_root`、`commit_oid`、`recorded_at`、`start_observation` 与完整性状态；不能只保存 branch、短 SHA、`HEAD` 或 checkpoint 文本。
- 新 Ticket 在同一条 `registered` journal record 中保存比较身份，避免 Ticket 已登记但 baseline 未落盘的半成功。重启通过 journal replay 恢复同一身份；refresh、session 切换、commit、branch 前移或 checkpoint 更新都不得改写它。
- 重复登记只有在项目/Ticket 元数据、worktree 和已解析 baseline 全部相同时才幂等；不同 baseline 返回 `REGISTRATION_CONFLICT`，不静默重定基线。Workflow fixed point 仅用于交叉校验；冲突显示 `BASELINE_WORKFLOW_MISMATCH`，不自动采用较新的值。
- 缺 worktree、缺 fixed point、commit 不存在或仓库身份无法验证时，Ticket 仍按旧契约可登记，但 `changes.state = unavailable`，给出具体 gap；不得从当前 HEAD 猜 baseline。

### 2. 起点观察只服务归因边界，不改写 Git 比较语义

- 登记 baseline 时同步记录一次起点观察：当时的 `HEAD`、tracked staged/unstaged 路径、untracked 路径，以及可安全取得的内容 fingerprint；每个条目带 `observed / unavailable / truncated` 完整性。只保存清单、状态和 hash，不复制文件正文。
- 主 Changes 仍定义为 `baseline commit tree -> 当前工作树` 的累计净变化。起点观察不从结果中扣除原有 dirty/untracked；它用于把这些路径标为 `pre-existing-at-start`，避免把“相对 fixed point 已变化”误说成“本票/Agent 新增”。若同一路径之后继续变化，标为 `pre-existing-overlap`，归属仍不确定。
- 旧 journal 必须继续可读。旧 Ticket 没有 baseline 时不回填历史起点、不伪造 start observation，只返回 `BASELINE_NOT_RECORDED`。若后续需要迁移，只允许一次显式 baseline adoption，并永久带 `late-baseline / start-not-observed` gap；本票不做批量迁移。

### 3. 累计净变化由 baseline tree、当前 Git 和实际文件合成

- tracked 内容以 baseline commit tree 与当前工作树的 tree-to-worktree diff 为准；因此 baseline 后的 commits、index 和未暂存修改会合并为同一份当前净结果。commit 后 HEAD 前移不会清零；后续 revert 会按“净变化”自然抵消。
- untracked 不属于 Git diff，单独从 `git status --porcelain=v1 -z --untracked-files=all` 枚举，再从实际文件生成 addition 状态、fingerprint 和受限预览。路径必须经过现有 worktree containment / protected path policy；symlink、特殊文件、超限或读取失败只保留元数据和 gap，不跟随、不硬读。
- 结果包含 baseline OID、当前 HEAD、每个 path 的 change kind、事实来源、起点标记及完整性；rename/copy 采用 Git 的检测结果并注明其为 Git heuristic。大 diff / 二进制内容按明确上限截断，保留 `truncated`，不得把截断当作无变化。
- commit 下钻来自真实 Git comparison range。baseline 是当前 HEAD ancestor 时列出 `baseline..HEAD` 中的 commits；若不是 ancestor，tree diff 仍可回答当前净内容，但 commit range 标为 `HISTORY_DIVERGED` / incomplete，不把分叉后的列表表述成完整“本票期间提交”。

### 4. 过程关联与修改归属是两个独立维度

- run 下钻列出本 Ticket 已显式绑定的 run，并标 `association = ticket-process`；这只证明该 run 属于本票观察过程。
- commit 下钻标 `association = comparison-range`，可附可观察到的 run/工具引用；commit author、时间重合、命令输出或 Agent 自述都不提升为修改归属。
- path / commit / run 统一公开 `modification_ownership = proven | not-proven | conflicted` 与 `ownership_evidence[]`。当前 Harness 没有 proof-grade 的原子 before/after 文件身份，因此 HARNESS-007 默认输出 `not-proven`；不要从 command text、当前 diff 或 attached run 推断 Agent ownership。
- 未来只有结构化成功写操作同时具备显式 Ticket、规范化 path、紧邻操作的 post-write identity，且没有冲突证据时才可产生 `proven`。该采集升级不是本票前置，也不能在本票中用启发式冒充。
- 起点 dirty/untracked、baseline 后未观察窗口、多个相关 run、外部/并发编辑或事实冲突均加入 attribution gaps。Changes 不承诺恢复未观察到的中间编辑。

### 5. refresh、freshness 与 evidence gap 必须是一等字段

- Changes 使用独立 read-only `ChangesSource` 查询 Git / filesystem，不从 Event Store、Workflow snapshot 或 Agent 回复派生当前内容。Event Store 只提供 baseline、run 关联和已观察过程。
- 显式 UI/API refresh 与 Runtime reopen 都重新核验：canonical repository/worktree、baseline object、当前 HEAD、ancestor 关系、tracked diff、untracked files。每次结果带 `checked_at`、各 source 的 `observed_at/state` 和整体 `freshness = current | stale | unknown`。
- 刷新失败不得沿用旧成功值冒充当前事实：可以保留 `last_successful` 供参考，但当前 freshness 必须为 `stale/unknown`，并列出 code、source、impact。恢复后下一次 refresh 重新计算，不自动执行工程动作。
- 至少表达：`BASELINE_NOT_RECORDED`、`BASELINE_COMMIT_UNAVAILABLE`、`REPOSITORY_MISMATCH`、`GIT_UNAVAILABLE`、`HISTORY_DIVERGED`、`START_SNAPSHOT_INCOMPLETE`、`UNTRACKED_CONTENT_UNAVAILABLE`、`CONTENT_TRUNCATED`、`OBSERVATION_GAP`、`ATTRIBUTION_UNPROVEN`。这些是结构化 gap，不只是一段笼统 warning。

## 数据 / 状态语义

- `Ticket.comparison_baseline`：nullable、写入后不可变；null 是兼容旧记录的显式状态。
- `ComparisonBaseline`：`repository_id`、`worktree_root`、`commit_oid`、`recorded_at`、`adoption = at-registration | late`、`start_observation`、`integrity`。
- `ChangesView`：`state`、`baseline`、`current_head`、`files[]`、`commits[]`、`runs[]`、`freshness`、`sources`、`evidence_gaps[]`。
- `FileChange`：净 change kind、path / optional old path、content metadata/preview、`fact_source`、`start_relation`、`process_associations[]`、`modification_ownership`。
- baseline 身份属于 journal durable state；Changes 内容是按请求刷新的外部事实，不作为新的 append-only 历史流逐次落盘。这样避免每次刷新制造 journal 噪声，同时 reopen 仍由持久 baseline 重建当前视图。
- `recording-failed` 不阻止只读 Git/file refresh；但 attribution 的 observation history 同时显示 recording gap。比较事实可为 current，不代表过程证据完整。

## TDD seam

Primary seam 使用新的 `tools/codex-session-bridge/test/harness-changes.test.ts`，从公开 MCP 登记 Ticket，再通过 Ticket API / HTML 验证：

1. 建立真实临时 Git repo；在 fixed point 后预置 tracked dirty 与 untracked，登记 Ticket，断言 baseline 是完整 OID且起点项标为 pre-existing。
2. 登记后产生一次 tracked commit，再保留新的 working-tree 修改与 untracked；刷新后同一 Changes 同时包含 committed + working tree + untracked，baseline 不变且 commit 不清零。
3. 关闭并重建 Harness，断言 Ticket ID、baseline 身份与重新计算的净变化保持；不依赖旧内存缓存。
4. 绑定真实 fixture run，并制造外部/并发文件编辑；run 显示 process association，而 path/commit ownership 仍是 `not-proven`，没有 Agent 贡献措辞。
5. 暂时使 repo/baseline 不可核验，断言 freshness/gap 公开且旧成功值不冒充 current；恢复后 refresh 回到 current。
6. 用 legacy journal fixture 验证旧 `registered` record 仍能 replay，Changes 返回 `BASELINE_NOT_RECORDED`；若覆盖 late adoption，只验证一次显式 adoption 与永久 gap。

Secondary seam 只在主 seam 难以定位时补充 `ChangesSource`：NUL-delimited status/rename、baseline 非 ancestor、untracked/特殊文件限制与超限截断。不要扩成 Git 行为矩阵，不跑 full suite。

## 最小代码写集

- `tools/codex-session-bridge/src/harness/model.ts`：兼容式 baseline / Changes schemas 与 journal record replay。
- `tools/codex-session-bridge/src/harness/changes-source.ts`（新）：受限 Git/file facts、repository identity、baseline capture 和 refresh。
- `tools/codex-session-bridge/src/harness/changes.ts`（新）：把 baseline、current facts、run bindings 组合成公开 ChangesView；不承担 Git 命令细节。
- `tools/codex-session-bridge/src/harness/harness.ts`：登记时固化 baseline、restart replay、detail/overview 接入 Changes；保持旧 Ticket 降级可读。
- `tools/codex-session-bridge/src/harness/server.ts`：Ticket API/HTML 显示累计 Changes、run/commit 下钻、freshness/gaps，并移除该处 `Changes：unavailable` 占位。
- `tools/codex-session-bridge/src/mcp.js`：只更新登记工具的公开描述；schema 仍从 model 导入。
- `tools/codex-session-bridge/test/harness-changes.test.ts`（新）及必要的 `harness.test.ts` 兼容断言。除非实现证明必须，不改 Workflow model/source、computer-call 记录或 Conversation 模型。

## 风险与 Deferred

- Git common-dir 是本机仓库身份，不是跨 clone 的全球 repository UUID；同路径换成另一 clone 必须报 mismatch。跨 clone 迁移需未来显式产品语义，不能静默接受。
- 未跟踪正文、二进制和大文件存在安全/体积风险；本票坚持受限预览 + hash + gap，不为完整 patch 放宽 protected path 或内容策略。
- Git rename detection 是启发式；concurrent editor 没有可靠 actor identity。两者都不得升级为 proven ownership。
- baseline 不是 ancestor 时仍可比较 tree，但 commit drilldown 不完整；不要在本票引入自动 rebase/merge-base 替换 baseline。
- 无 Owner blocker。上述决定均落在 Ticket 已授权的实现级 deferred 内，没有改变 Spec 的产品边界。

## 实现顺序

1. 先以 product fixture 写 baseline 持久化、commit 后不清零、dirty/untracked attribution 与 restart/freshness 的红测试。
2. 增加兼容 schema 和 baseline capture/replay，再实现纯 Git/file `ChangesSource`。
3. 组合 `ChangesView` 并接入 Harness detail/overview；最后更新只读 HTML 下钻与 warning。
4. 只运行新增 changes 测试、受影响 harness 测试与 typecheck；full suite 交由外层 YCA。

## Context Plan

- **Core**：`.local/HARNESS-007-ticket.md`、本 Notes、`AGENTS.md`；`tools/codex-session-bridge/src/harness/{model,harness,journal,server}.ts`；新增 changes source/model；`tools/codex-session-bridge/test/harness-changes.test.ts`。
- **Related**：`docs/specs/yuki-harness-v0.md` 71–90 / 94–108；`docs/design/yuki-harness-v0-handoff.md` 120–163 / 234–246；`workflow-source.ts` 的安全 Git/path/时效先例；`codex-source.ts` 与 binding 仅用于 process association。
- **Cold**：HARNESS-001～006 history、完整旧 Notes、Control Center、Workflow Review/Acceptance tests、HARNESS-008+。
- **Expansion triggers**：旧 journal 无法在 nullable/default schema 下 replay；当前 Git wrapper 无法安全表达 NUL paths/特殊文件；公开 MCP 登记不能原子固化 baseline；现有 content/path policy 与 untracked 预览发生安全冲突。只有触发时再按具体 symbol/fixture 扩读，不先扩大实现面。

The current ticket is ready for implementation.

## Implementation Handoff

- 来源：`.local/HARNESS-007-ticket.md`、`docs/specs/yuki-harness-v0.md`、本 Implementation Notes；实现基线为 `a71817e43837f61e5e298ff14c6d30d7475594da`，Ticket fixed point 为 `b1e19f4e34b46306f342e42ba19adcc80809d6d7`。
- 身份：worktree `C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-007`；branch `codex/yuki-harness-v0-007`；本 session 未 commit，工作树只包含下列 HARNESS-007 实现与本 handoff。
- 范围：`model.ts` 为登记与 legacy replay 增加 nullable immutable baseline/start observation；新增 `changes-source.ts` 与 `changes.ts`，以受限 Git/file refresh 组合累计净变化、commit/run 过程关联、ownership 未证明语义、freshness 与结构化 gap；`harness.ts`、`server.ts`、`mcp.js` 接入 detail/overview、HTML 和公开登记描述。未修改 Workflow source/model、Conversation 或 computer-call 语义。
- 实际文件：`tools/codex-session-bridge/src/harness/{model,harness,changes-source,changes,server}.ts`、`tools/codex-session-bridge/src/mcp.js`、`tools/codex-session-bridge/test/harness-changes.test.ts`、`tools/codex-session-bridge/test/harness-workflow.test.ts`、本 Notes。
- TDD：首次 `node --test test/harness-changes.test.ts` 退出 1，4/4 红；公开登记拒绝 `fixed_point`，legacy Ticket 无显式 baseline。实现后同命令退出 0，4/4 绿，覆盖 baseline/start dirty 与 untracked、commit 后累计不清零、restart/reopen、run association 不等于 ownership、freshness 恢复和 legacy replay。
- 定向验证：`node --test test/harness*.test.ts` 退出 0，46/46；`npm.cmd run typecheck` 与 `git diff --check` 均退出 0。未运行 `npm test` / full suite，按 Ticket 交由 Emilia/YCA 外层执行。
- Review policy：delegated，fresh Review pending；本 implementation session 未执行 Review/Acceptance/closeout。
- Deferred / Review risk：请重点核对 Windows/Git NUL path 与 rename heuristic、2048 path/64 KiB content 安全上限、protected/special/unreadable untracked gap、diverged history、legacy nullable replay，以及 overview 每票实时 Git refresh 的成本。Changes 只证明当前净事实；run/commit/path ownership 均保持 `not-proven`。
- Expansion trigger：未触发；兼容 schema 可 replay legacy journal，公开登记可在单条 `registered` record 固化 baseline，自有 Git wrapper 与现有 containment/protected 语义足以覆盖本票。
- Commit：Owner 明确禁止 commit/push；当前结果为未提交工作树，不存在新的实现 SHA。
- 下一步：Emilia/YCA 先执行外层 full suite 与实际 diff 核对，再从当前未提交字节启动 fresh delegated Review；不得把本 handoff 表述为 Review 或 Acceptance 已通过。

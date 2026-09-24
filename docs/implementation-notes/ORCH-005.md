# ORCH-005 — Engineering Memory V0 与 Context 集成

状态：ticket-design + fresh design review 完成；3 条 review finding 已纳入设计，ready for implementation。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/92
Source Spec：GitHub #89（Emilia Orchestration Consistency V0，含 2026-09-24 Addendum）
Fixed point：`81ea2ed5e240e0e7e3225250e7a6dc405af3a48a`
Branch：`codex/orch-005-engineering-memory-r2`

## Implementation Decisions

- **独立 Memory domain / store。** Engineering Memory 不写入 Harness `history.jsonl`；Harness 继续只拥有 execution / Conversation / Workflow evidence。V0 新建独立 `EngineeringMemoryStore` 抽象，并以 runtime 下独立 append-only JSONL 实现；共享现有 `RuntimeStore` 单实例 ownership，不再引入第二套进程锁。
- **V0 不引入 SQLite。** 当前工程无 SQLite 依赖，Memory 规模与查询复杂度不足以证明新增数据库、migration 与部署依赖的价值。上层 service/query contract 不暴露 JSONL 细节，未来可替换为 SQLite / FTS / remote adapter；生命周期与 scope/applicability 语义保持不变。
- **Operation log 是 durable truth。** JSONL 每行表达完整 Memory operation，而不是可变 snapshot。支持 create / supersede / invalidate；启动时 replay 并校验完整记录，尾部不完整或不可验证状态 fail-closed，不静默丢失已完成历史。
- **Supersede 以单条 durable operation 为事务单位。** 一条 supersede operation 同时携带 replacement active record、旧 record superseded 状态和双向关系；只有整条记录 durable 后 projection 才同时切换，避免崩溃留下两个同级 active。禁止 replacement cycle、对非 active/不存在记录 supersede、以及同 logical key + exact scope + applicability 的同级 active 冲突。
- **Invalidate 不可逆。** invalidate operation 必须保存 reason 与 source；active → invalidated 后不能原地 re-activate。需要恢复相似知识时创建新 record；历史查询仍可看到旧 record。
- **Typed record contract 固定五类。** Rule / Decision / Incident / Lesson / KnownBug 共用 stable id、logical key、short summary、scope、applicability、sources、lifecycle，并对 type-specific payload 做最小 schema 校验。禁止 Project State / Ticket State / HEAD / active run / PR status 等动态工程状态进入 Memory。
- **显式 Memory API。** application layer 提供 create / supersede / invalidate / query/history 的确定性服务接口；MCP 只暴露显式写入与查询，不自动从聊天、日志、Review 或 closeout 抽取。
- **scope/applicability 使用固定的 V0 集合语义，不做“更具体者优先”。** `scope` 至少含 `project_key`，可选 `repository` / `component`；缺失可选维度表示该 project 内 wildcard。`applicability` 只允许有限维度 `workflow_phases[]` / `actions[]` / `workflow_versions[]`，缺失维度表示 unconstrained；不支持 regex、否定条件或自由文本 evaluator。record 匹配 query 当且仅当 project 相等、所有受约束 scope 标量相等，且每个受约束 applicability 维度包含当前 query 值。相同 `logical_key` 的两个 active record 只有在其 scope/applicability 域可证明**不相交**时才允许共存；任一维度 wildcard 会与该维度所有值重叠。create / supersede 对重叠域 fail-closed 为 active conflict；replay 若发现历史冲突则该 key 的 active records 全部不注入并显式报告 conflict。V0 不做 specificity ranking 或 semantic ranking。
- **Rule authority 验证到具体 directive，而不是只验证整份文档。** V0 `RuleAuthorityRef` 只接受受信任 Markdown authority：repo 根 `AGENTS.md`、`.workflow/skills/**/SKILL.md`、以及当前 Spec 的受信任 source adapter。引用至少保存 `path + heading_path + unit_kind(paragraph|list-item) + unit_sha256`；adapter 对 bounded regular file 做 realpath / symlink / size 校验，按 heading path 定位并对规范化 directive 单元逐个哈希，必须恰好命中一条。adapter 同时从 authority 类型派生**最大适用范围**：repo `AGENTS.md` 可到 repo 范围；Skill 规则不得扩出对应 workflow action/skill；Spec 规则不得扩出该 Spec/Ticket lineage。Memory Rule 的 scope/applicability 必须是该 authority scope 的子集。directive missing / ambiguous / digest drift / applicability 过宽 / source unverifiable 均为 stale，并从默认注入排除；Memory 摘要永远不是第二个 rule source。
- **Context Packet 只携带短摘要与 source reference，并把 Memory 诊断与 ORCH-001 核心 readiness 隔离。** `retrieval.engineering_memory` 自带 `status / integrity / items / stale / conflicts / omissions`；只投影数量/字节有界的 active + applicable summaries、record id/type/logical key/source refs，不复制完整 payload。stale Rule、冲突 key 或 unverifiable authority 均不注入；Memory store/query unavailable 时返回 `status=unavailable` + omission。**这些 Memory-local stale/conflict/unavailable 不提升 top-level Context `integrity`、也不阻断普通 Ticket `action_readiness`**，因此不会让一条被排除的旧 Memory 阻断无关动作；ORCH-001 的 Git/Workflow/checkpoint/runtime 核心证据仍独立决定 readiness。只有显式 Memory write/query MCP 自身失败时，该 Memory 操作 fail-closed。
- **边界保持可升级。** `ContextAssembler -> EngineeringMemoryQuery -> EngineeringMemoryStore`；assembler 不直接读取 JSONL。未来迁移 SQLite/FTS 时替换 store/query adapter，不改变 Context Packet、MCP lifecycle API 或 ORCH-006 的集成语义。


## Fresh Design Review Resolution（2026-09-24）

- Reviewer：GPT-6 Sol high，session/run `6dbf5d72-cc77-4e3d-ac10-dfeeb286d842` / `febbd2af-5450-46d6-9817-5ba64ef104c2`。
- 原 Verdict：`NEEDS_CHANGES`；独立 JSONL store、RuntimeStore 单实例 ownership、单条 supersede operation 的主方向认可。
- Finding 1（Rule authority 粒度）→ 已通过“具体 Markdown directive selector + authority-derived maximum scope”收口。
- Finding 2（scope/applicability overlap）→ 已固定 V0 维度、wildcard、匹配与 overlap-conflict 语义；无 specificity ranking。
- Finding 3（Memory 对 Context readiness 的影响）→ 已改为 Memory-local diagnostics，不污染 ORCH-001 top-level readiness。
- 以上均为 implementation contract；无需再次设计 review，后续以实现/测试与 primary Review 验证。

## Implementation Sequence

1. 定义 typed record / operation / query schema 与稳定错误语义。
2. 实现独立 append-only JSONL store、replay/projection、写入安全与 create/supersede/invalidate lifecycle。
3. 实现 deterministic query 与 Rule authority validation adapter。
4. 在 manager/application composition 中实例化 Memory service，并暴露显式 MCP create/supersede/invalidate/query(history) 能力。
5. 扩展 Context facts / assembler：bounded Engineering Memory summaries、source provenance、stale/conflict/omission。
6. 以公开 MCP + Context Packet seam 做定向测试；重启后 replay 验证 lifecycle 不变。

## Test Seam

- 五种 typed record 的最小 payload 校验；动态 Project/Ticket 状态字段不能借 payload 绕过边界。
- create 幂等/冲突语义、同级 active conflict。
- supersede 单 operation 原子投影、双向关系、禁止 cycle；注入故障不能留下双 active。
- invalidate 必须 reason/source、不可原地复活；历史查询仍可见。
- 重启 replay 后 active/superseded/invalidated projection 一致；损坏/不完整 durable log fail-closed。
- scope/applicability 固定维度过滤；同 logical key 的 active domain overlap 在 create/supersede 时拒绝，replay 检出历史 overlap 时该 key 全部不注入；默认只 active，history 显式包含历史。
- Rule authority 必须具体定位 directive 且 scope/applicability 不超出 authority-derived maximum scope；missing/ambiguous/drift/over-broad → stale 且默认不注入。
- Context Packet 仅投影 bounded summaries/source refs；Memory-local stale/conflict/unavailable 可观察但不改变 top-level readiness；Memory 不覆盖 Git/checkpoint/Harness/runtime 当前事实。
- 保留 ORCH-001 Context Packet read-only 性质：assemble / prepare resume 不写 Memory、不推进 Workflow、不启动模型。

## Deferred Low-risk Details

- 文件名、内部 class/helper 命名、具体错误码字符串与 fixture 组织按现有 Bridge/Orchestration 风格决定。
- V0 不实现 SQLite/FTS/embedding/RAG、Memory UI、自动抽取、跨项目 semantic ranking；未来 store migration 通过稳定 service contract 演进。

### Context Plan

- **Core:** GitHub #92 acceptance；本 Notes；`tools/codex-session-bridge/src/orchestration/{context-contract.ts,context-assembler.ts,harness-context-source.ts}`；`src/mcp.js`；现有 runtime/store 单实例与持久化约束。
- **Related:** GitHub #89 的 Engineering Memory / Context Packet / source-of-truth 边界；`src/harness/journal.ts` 仅作 durable append/replay 先例，不把 Memory 并入 Harness；`src/store.js` 的 runtime ownership/atomic save 约束；ORCH-007 已合并的 unified Workflow Agent 仅作为当前 orchestration baseline。
- **Retrieval:** 搜索 `ContextAssembler`、`ContextFactsSource`、`RuntimeStore`、`Journal.append`、MCP register 先例与 context budget tests；历史 ORCH-001 只在 contract 不清时按需读取。
- **Expansion triggers:** 若单进程 runtime ownership 不能覆盖 Memory writer、authority verification 需要新的外部 source 协议、JSONL 无法在单条 operation 下满足 crash-safe lifecycle，或 Context Packet budget/contract 必须破坏兼容，先停下更新设计再扩范围。

## Implementation Handoff（2026-09-24）

- 来源：GitHub #92；source Spec #89；本文件 Implementation Decisions。fixed point `81ea2ed5e240e0e7e3225250e7a6dc405af3a48a`；worktree `.local/worktrees/orch-005-r2`，branch `codex/orch-005-engineering-memory-r2`。
- 范围：新增独立 append-only JSONL Engineering Memory store 与五类 typed record、create/supersede/invalidate/query；通过共享 runtime owner 的单一投影接入显式 MCP；Context Packet 只投影有界摘要、source references 与 Memory-local stale/conflict/unavailable 诊断。Rule 对受信任 Markdown 的具体 directive 做 heading/unit digest 校验，并核对 repository/action/Spec Ticket 引用范围。
- 测试：`node --test test/orchestration-memory.test.ts`（4/4）；`node --test --test-name-pattern='public Memory write' test/orchestration-context.test.ts`（1/1）；`npm run typecheck`（exit 0）；`git diff --check`（exit 0）。测试目录为 `tools/codex-session-bridge`。完整测试套件与真实运行服务链路未在本 implementation session 执行。
- Review policy：`delegated`，接收方 Ticket Main；primary Review pending。本 session 未执行 Review、Acceptance、PR、部署或 closeout。
- Finding/风险：fresh design review 的三项 finding 已按本 Notes 的 contract 实现；实现尚无 primary Review 结论。Memory store 为单进程 runtime owner 假设，HTTP 请求共享一个 writer；真实服务重启链路待后续验收核对。
- Commit：精确 SHA 由同 worktree `.local/workflow-state/ORCH-005-R2.md` 的 post-commit 记录提供。
- 下一步：从本 handoff、fixed point、实际 commit 与定向测试结果启动 fresh primary Review；不继承 implementation 聊天。

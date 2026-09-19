# 006 — Workflow v1.1 端到端验收与正式启用

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 用已确认 primary acceptance seam 真实跑通 Workflow v1.1，并在证据充分后正式启用，不把“若干单点能力分别可用”误写成整套工作流已稳定。

**Blocked by:** 001、003、004、005.

**Risk hint:** high

**Status:** accepted

## Acceptance criteria

- [x] 在临时 fixture 仓库从 Design Handoff / Spec / Ticket 启动 `engineering-workflow`。
- [x] ticket-design → implementation 按规则保留连续上下文。
- [x] full Review 使用 fresh reviewer。
- [x] 人为构造 finding 后，修复进入 fresh focused re-review。
- [x] docs-only / closeout 进入 evidence Review，且更高风险可升级。
- [x] checkpoint 在正确边界更新，动态事实会重新验证。
- [x] acceptance 使用 filesystem/Git/command/test/YCA events 等 ground truth，而不是模型自述。
- [x] closeout archive 正确生成且不复制大型 raw logs。
- [x] 新开完全 fresh session 后，仅凭持久化产物可以恢复并继续正确 next action。
- [x] 人为触发至少一次 external interruption（模拟 ChatGPT 审查/客户端断连/对话切换），中断前后 phase、finding、diff、next action 保持一致，且不重复已完成阶段或副作用。
- [x] Codex 等待期间 observation wait 不会终止仍在推进的 run，且重复轮询显著减少。
- [x] 单独调用 `implement` 的兼容行为仍成立。
- [x] 最终能力说明明确区分 implemented / accepted / stable；本票通过只证明真实链路验收，不自动宣称长期稳定。
## Implementation Notes

- **依据与边界。** Issue #28；以本票、正式 Spec 的 Testing Decisions、confirmed decisions 及当前 repo-local Skills 为准。implementation frontier 为空：以下收敛既定 seam 与执行顺序，无新的产品/架构决定。设计 ready，AC 仍待实际验收。本轮只写本地 Notes/checkpoint；tracker 未同步。后续由 Emilia 接续 implement，不把此设计交接当作实现、Review 或验收完成。
- **已有能力与缺口。** 001 已记录 resident MCP wait 三种返回及独立 deadline 的真实验收；002 提供 source/preview/apply/verify；003 的 `recovery-fixture.mjs` 提供独立 Git、一次性 effect/receipt、过期 checkpoint 和 fresh 恢复先例；004 的 `review-fixture.mjs`、`review-subject.mjs` 提供 standalone/delegated、分级 Review、完整内容身份与 observation 核验；005 提供 `observe → generate` archive 和公共脚本测试。003 的模拟 review/runtime、004 的 synthetic observation 只证明核验器/局部行为，不能拼接成 006 的真实链路。历史记录以各 Ticket、`003-local-acceptance.md`、`.workflow/history/005.md` 定位；本次仍须核对实际 source/工具身份，不把旧 Status/报告当当前 runtime 事实。
- **最小载体。** 一个主临时 Git fixture，加一个复用 004 `standalone` 的兼容支线，均置于本 worktree 被忽略的 `.local/workflow-fixtures/`。主 fixture 从已确认 Handoff + Spec + 无 Notes 的 Ticket 开始，不重跑 discovery/spec/tickets 发布。沿用 003 的 value=7/result=14 与一次性 prepare receipt，以及 004 的 `guest_private=false` 契约；准备/注入/核验是确定性脚本，Agent 从 `engineering-workflow` 公共入口选择阶段。复制当前 `.workflow/skills` 完整文件并记录 source commit/字节身份，不安装全局 Skills。仅按需要增补一个串联 fixture/helper 与简短操作说明、必要核验器测试，不重建路由框架或八场景矩阵。
- **主链与一次 finding。** fresh implementation session 实际执行 ticket-design，持久化 Notes 后在同一 session/thread 执行显式 delegated implement，到 handoff 停止；Emilia 核对真实测试/内容/commit。随后仅在 fixture 注入一次 staged `guest_private=true`（沿用 004 upgrade-evidence），保留 docs-only/low hint，重捕获完整 subject 并标明旧测试身份已失效；真实重跑失败结果不得隐藏。fresh reviewer 从公共入口按实际权限 diff 升级 full，调用同根 code-review，两个无实现历史的独立轴分别报告，并产生真实 F1。注入信息由验收者记录，不能预填 reviewer 结论或伪造 finding。
- **同链中断与恢复。** F1 open 后保存 `phase: implementation`、原双轴报告、修复前 subject、finding/next action 和一次性回执，结束当前观察/对话，模拟 external interruption；不 stop 仍在运行的 run。确认原 run terminal 后，新开完全无历史的 session，仅给 fixture root、Ticket、公共入口和授权边界，靠持久化材料恢复。只把 checkpoint 的缓存 HEAD 留为已知旧值来验证刷新，实际 Git/报告不篡改；核对恢复前后 phase、F1、工作 diff、next action 与 receipt 一致，再继续修复。修复后测试转绿、F1 fixed，另一个 fresh focused reviewer 只核对 F1 与直接回归，保留原双轴未变范围，完成后才记 verified；不再 full。按真实 trace、Git 与 effect count=1 证明没有重做设计、初次实现、full Review 或 prepare。
- **验收、归档与 evidence。** Emilia 逐条从文件、Git、命令退出码、受测/受审字节和真实 session/tool events 核对；主链 acceptance 通过后，使用 005 helper 从精简本地输入 observe/save/generate fixture archive。一次 fresh evidence Review 同时覆盖 docs-only 验收记录与 closeout 增量，使用明确的增量 fixed point，并引用此前 full/focused 结论；不把整个业务 diff 降成 evidence。核对必要字段、可追溯引用、raw 哨兵未复制及 `.local` 未跟踪。最终 006 只保存简短 AC 证据索引/能力说明与必要 archive，raw trace/JSONL/输入/命令输出留本机。
- **必要真实行为与成本。** 主链仅需 implementation（设计连续）、首次 full、fresh 恢复修复、fresh focused、closeout evidence；standalone 支线直接调用 implement、不传 policy，真实验证“测试 → fresh 完整双轴 → 本地 commit/handoff”。full 内两轴隔离按现行 code-review 执行，这是 AC 必需成本，不额外增加验收模型或路由探针。各角色输入仅含持久化来源与必要内容身份；不传实现聊天，不告知预期 mode/finding。session 隔离/continuity 由真实创建参数、session/thread 与工具事件证明；artifact checker 通过不等于行为通过。外层 006 的必要 Review 与 fixture 内角色区分记录，避免以 fixture 自证本票。
- **等待 seam。** 在上述必要真实 YCA/Codex run 上由 Emilia 使用 `codex_get_output(wait_ms, cursor)`，省略 execution timeout 并核对受理/status 的 `timeout_ms: null`；沿 cursor 观察 events、一次短 observation 的 wait_elapsed 后同一 run 继续产生进展并自然 terminal。必要时在 fixture 命令中加一个有界短等待，不另起研究 run、不等待旧分钟级阈值。记录观察区间、wait/status/output 调用数、等待耗时与返回原因；用同一时间窗下既有固定轮询 cadence 的计算值作标注为估算的对照，证明调用显著减少，不真的并跑旧轮询，也不宣称已有实测基线。若无可信 cadence 则如实 pending，先由确定性调用记录补足口径；不凭模型自述通过。显式 deadline 等已由 001 覆盖的矩阵不重复。

| AC（按上方顺序） | 最小证据 |
| --- | --- |
| 1、2 | 主 fixture 公共入口与实际 Skill 读取；Notes/handoff；同一真实 implementation session/thread |
| 3、4 | full 的 coordinator/双轴隔离事件与报告；真实 F1 → fixed → fresh focused verified |
| 5 | 同链 low/docs hint + staged 权限变更升级 full；末尾纯文档/closeout 增量 evidence |
| 6、9、10 | 边界 checkpoint 快照；一次 external interruption；fresh session 重查 Git/旧 HEAD、报告、run/receipt，恢复正确 next action；diff/finding/副作用未丢失或重放 |
| 7、8 | Emilia 的命令/测试/Git/真实事件索引；archive 输出及原始文件/跟踪清单检查 |
| 11 | 同一真实 run 的 events/wait_elapsed/terminal、后续进展及带明确统计口径的调用减少证据 |
| 12 | 004 standalone 支线的真实首次双轴 Review 在 commit 前发生，无 delegated policy |
| 13 | 能力说明仅将证据覆盖版本标为 accepted；implemented、accepted、stable 分开，stable 未证明 |

**最小执行序列：** 刷新 Git/source/可用真实 session 与 MCP 身份 → 准备主 fixture 和必要核验器 → 同 session 设计/实现 → 注入一次 finding 并 fresh full/升级 → 保存中断现场，fresh 恢复修复 → fresh focused → Emilia acceptance/生成 archive/closeout evidence → standalone 兼容支线 → 汇总 13 条 AC 和能力说明。工具验证只跑变更相关定向检查，最后一次 workflow-skills full suite/check；已有 closeout/subject 公共 seam 测试复用，不扩 drift/recovery、压力测试或安全矩阵。

**交接与门禁：** 没有新的 Owner 设计 blocker。真实 session/MCP/trace 不可用时对应 AC 保持 pending，并向上层交接环境事实，不用 synthetic 替代或自行扩大权限。正式启用先限定为显式读取该版本 repo-local source 的已验收链路；本票验收不隐含全局安装。若后续需要 protected/global apply，必须先完成具体 preview/diff，再单独取得 Owner 对该计划的批准。低风险脚本命名、证据 JSON 字段与摘要排版由 implement 沿既有约定决定；不改 AC，不关闭父 Issue，不宣称日常 stable。
## Implementation Handoff

- **授权与身份。** 本次按同一 Ticket Implementation Session 的明确 continuation 实现，`review_policy: delegated`，接收方 Emilia；未启动 sub-agent/reviewer。worktree 为 `C:/Users/KQ_Sh/Desktop/yuki-link/.local/workflow-v1.1-006`，branch `codex/workflow-v1.1-006`；开始时 fixed point/HEAD 均为 `74cad9a8131cede1ccfdd1163036fd551b905953`，仅有本票既有 Notes 未提交，已保留。没有本项目新 commit；上层已有 session/run 与 AC11 部分证据保留在 checkpoint，本轮未重新查询 YCA。
- **实际范围。** 新增 `tools/workflow-skills/fixtures/end-to-end-fixture.mjs`、`test/end-to-end-fixture.test.js`、`fixtures/end-to-end.md`；更新 fixture README 入口和 package.json 的 check 清单，以及本 Ticket/checkpoint。单主 fixture 从无 Notes 的 Ticket 与既有 Handoff/Spec 开始，复制并绑定完整 repo-local Skills，准备一次性 receipt；提供 check-implementation、一次 staged 权限 inject、保存真实报告/现场的 interrupt、修复前 check-resume 和 check-closeout。interrupt 只人为留旧缓存 HEAD，不制造 Review 报告、不改变 phase/F1/diff/next action 或停止 run。standalone 沿用 004；完整 subject 与 archive 分别调用现有 004/005 公共 helper，没有重建相关逻辑、路由器或场景矩阵。
- **定向红→绿。** 只运行 `node --test tools/workflow-skills/test/end-to-end-fixture.test.js`（中间两轮用 `--test-name-pattern` 限定当前切片）。第一轮因 helper 缺失 `MODULE_NOT_FOUND` 红灯，补 create/check-implementation 后 1/1 绿灯；第二轮因 inject 命令未实现红灯，补注入/中断/恢复后当前切片 1/1 绿灯；第三轮因缺 closeout-input 模板 `ENOENT` 红灯，连接 005 observe/generate 与 checker 后当前切片 1/1 绿灯。最后一次定向文件 **3/3 pass、0 fail、0 skip，exit 0**；Node v24.18.1。验证缺失产物/重复 prepare 拒绝、一次注入实际权限红灯、重复注入/中断拒绝、旧 HEAD/报告变更/diff 丢失拒绝、恢复后权限修复转绿、pending archive/raw 哨兵泄漏拒绝；全部是 synthetic checker 测试，不是 Agent 行为验收。
- **证据与内容绑定。** 原始红绿日志在 `.local/workflow-validation/006/{create,interruption,closeout}-{red,green}.txt`，最终结果在 `targeted-final.txt`；五个实现/测试/说明/package 文件的 SHA-256 在同目录 `implementation-files.json`。本地未提交范围还包含本 Ticket（Notes/handoff）；raw、输入和 checkpoint 不入 Git。测试仅在临时仓库创建 synthetic Git baseline/实现提交并生成测试 archive，不是对本项目 commit，也不是执行外层 closeout/Acceptance。未创建另一个待运行的真实验收 fixture 或启动真实模型。
- **限制与待办。** checker 只验证产物和字节一致性，所有成功仍返回 `behavior_acceptance: pending-external-trace-review`。session continuity/fresh 隔离、实际 full/focused/evidence 路由、不重放阶段、真实等待与调用减少、archive 来源语义均须 Emilia 从真实 trace/Git/命令与报告核对。中断检查要求 F1 open、指定 checkpoint section 与修复前字节保持；是本票受控边界检查，不是通用语义解析器。closeout checker 在 archive 提交前执行；不代替生成回执和 evidence consistency Review。缺真实证据保留 pending，不用 synthetic 冒充 accepted；长期 stable 未证明。
- **机械收尾与 Review 状态。** 按 Owner 本轮明确分工，最终完整 `npm --prefix tools/workflow-skills test`、`npm --prefix tools/workflow-skills run check`、最终 Git diff/check/写集检查与本项目 commit **均 pending，由 Emilia 在本 run 结束后执行**；未运行或提交，不把旧 HEAD 当实现 commit。无 TypeScript，typecheck 不适用。Review delegated/pending，尚无本票语义 Review 结论，不能声称零 finding；外层 Acceptance/closeout、push/PR/merge/Issue close、全局 Skills/protected apply 均未执行。
- **下一步。** Emilia 先重核现场和受测文件摘要，执行上述 full validation 与最终写集核对，只提交本票文件；成功后补实际 commit/内容身份并将 checkpoint 交接到 review，再由 Emilia 按 repo-local workflow 启动必要 fresh Review。本次 checkpoint 保持 `phase: implementation`，没有 Owner 设计 blocker，不追加验收模型或旁支测试。
## Emilia Mechanical Validation

- 完整 `npm --prefix tools/workflow-skills test`：**54/54 通过，0 fail、0 skip，exit 0**；原始输出保存在 `.local/workflow-validation/006/full.txt`。
- `npm --prefix tools/workflow-skills run check`：exit 0，已包含新增 `end-to-end-fixture.mjs` 的 Node syntax check；输出保存在 `.local/workflow-validation/006/check.txt`。
- `git diff --check`：exit 0；最终未提交写集仅包含本 Ticket、`tools/workflow-skills/package.json`、fixture README，以及新增的 `end-to-end-fixture.mjs` / `end-to-end.md` / `end-to-end-fixture.test.js`。`.local` 证据与 checkpoint 未进入 Git。
- Ticket Implementation Session：`9c51cca2-94b0-4d0d-ab81-78897ca06811`；ticket-design run `b1677e21-4b43-453c-993d-bba6c7c11221` 与 implementation run `04579e4d-43ef-46c4-875f-6c9d6fcdcfd7` 均自然 completed、exit 0、`timeout_ms: null`，复用同一 Codex thread `01a0b7fc-2340-7bc3-98c0-2aec3c574cae`。
- 本节只记录实现后的机械验证；delegated Review、真实 fixture Agent/session Acceptance、closeout 与交付仍 pending，不据此把 006 标为 accepted/stable。

## Acceptance Fix Handoff

- **当前 blocker / 修复基线。** Acceptance 反馈：真实 Reviewer 产出 `FIXTURE-006-SPEC-001`（P1/open），source helper 的 `checkpointState()` 却要求字面量 F1，导致 interrupt 拒绝合法 checkpoint。修复前 HEAD 为 `458659697abb36fa3170cffe6e2b073ae564ad54`；本轮同一 implementation session，Review 继续 delegated 给 Emilia。
- **最小修复。** helper 改为检查 finding 条目内含稳定 ID（字母开头、含数字，可有连字符/下划线）与 `open`；保留原 finding section 的完整快照/恢复比较，身份或状态改变仍拒绝。不增加 Markdown parser、不改变其他阶段。操作说明删除强制 F1 别名，归档模板使用“原 finding ID”。本票前文 F1 只是示例简称，实际执行以 Reviewer ID 为准，不改真实报告/checkpoint。
- **定向 TDD。** 仅运行 `node --test --test-name-pattern='stable finding identity' tools/workflow-skills/test/end-to-end-fixture.test.js`：先因 `/\bF1\b/` 拒绝真实格式 ID 红灯（exit 1），修复后 **1/1 pass，exit 0**。同一回归检查 interrupt/check-resume 接受原 ID/open、拒绝无 finding/非 open，以及恢复时 ID 替换；全部使用独立 synthetic 测试仓库。日志：`.local/workflow-validation/006/finding-id-{red,green}.txt`。没有操作真实验收 fixture，没有改其 Review 或 checkpoint，没有启动 reviewer。
- **变更与剩余动作。** 修改 source helper、对应 test、同目录操作说明、本 Ticket 与 outer checkpoint。未跑 full suite、未 commit；仅标记 source 修复完成，fresh focused re-review 与真实 Acceptance 继续 pending。outer phase 回到 implementation；Emilia 机械核对变更/测试并 commit 后，启动 fresh focused re-review，只审本 blocker 与直接回归，再使用原 finding ID 接续原现场验收，不重跑已完成阶段。旧实现文件摘要只适用修复前版本。

## Acceptance Results

观察时间：2026-09-19。13 条 Acceptance Criteria 均以真实 Git / 文件 / 测试 / YCA 事件或真实 Agent Review 证据核对为 PASS；synthetic checker 仅用于验证验收载体，不单独作为行为通过依据。

| AC | 结果 | 关键证据 |
| --- | --- | --- |
| 1 | PASS | 主 fixture `end-to-end-006-TtRZFF` 从 Design Handoff / Spec / 无 Notes Ticket 进入 repo-local `engineering-workflow`；`docs/acceptance.md`。 |
| 2 | PASS | ticket-design → delegated implementation 复用真实 thread `01a0b81a-9d09-7fb1-a29c-a053575452bb`；实现 commit `cd8d1b9`。 |
| 3 | PASS | 权限 staged diff 将 low hint 实际升级 full；fresh coordinator `01a0b81e-...`，Standards / Spec 两轴独立 `fork_turns=none`。 |
| 4 | PASS | `FIXTURE-006-SPEC-001` / P1：open → fixed → fresh focused verified；focused session `01a0b82c-...`，未重跑 full。 |
| 5 | PASS | 高风险权限变化实际升级 full；主 fixture 的 `docs/acceptance.md` + closeout archive 由 fresh evidence Review 验证，报告 `.local/evidence-review.md`，0 finding。 |
| 6 | PASS | external interruption 后 fresh recovery 重新读取 Git / Review / receipt，发现并刷新 stale HEAD；finding、diff、Next action、side effects 保持。 |
| 7 | PASS | Emilia 直接使用 Git、filesystem、命令退出码、测试、YCA status/output 和内容摘要核验；未用模型自述替代 Acceptance。 |
| 8 | PASS | `.workflow/history/FIXTURE-006.md` 由 005 closeout helper 生成；raw sentinel 260000 bytes 留在 ignored `.local`，Evidence Review 确认 archive 未复制 raw。 |
| 9 | PASS | fresh recovery thread `01a0b824-...` 未继承旧聊天，仅凭 Ticket/Spec/checkpoint/reports/receipt 恢复到正确 implementation next action。 |
| 10 | PASS | 受控 external interruption 前后 phase / finding / diff / Next action / receipt 保持；`effect.count=1`，未重做 prepare、初次实现或原 full Review。 |
| 11 | PASS | run `b1677e21-...` 的 `codex_get_output(wait_ms=60000)` 实际返回 `wait_elapsed`，同 run 后续继续产生事件并自然 completed，`timeout_ms=null`。旧 `0c688d9^` live-test 每 1.5s 执行 output+status；同一 60s 窗口估算 80 次调用，对比当前 1 次，约减少 98.75%。这是基于旧代码 cadence 的估算，不冒充历史运行实测。证据：`.local/workflow-validation/006/wait-polling-evidence.json`。 |
| 12 | PASS | clean standalone fixture `review-004-exhZUF` 未传 delegated policy；未提交 `result.txt` 时先完成 fresh full 双轴（Standards 0 / Spec 0 finding）并最终 subject revalidation，随后才 commit `58413bafa7afd4642d9a1eb512fd8753053f9e4a`。证据：`.local/workflow-validation/006/standalone-evidence.json` 与 fixture `.local/standalone/final-checkpoint.json`。先前 `review-004-rexp6E` 因尝试读取 fixture 外 memory 被主动停止并排除，不作为验收证据。 |
| 13 | PASS | 能力级别按下方声明分离；本票只把真实链路标为 accepted，不把单次验收写成长期 stable。 |

### Capability status

- **implemented**：Workflow v1.1 所需 source / Skill / checkpoint-recovery / review routing / closeout / wait 能力已实现；006 Acceptance blocker 修复提交为 `2032fcf66db7ae0f6fd23a82d0343f121148b11a`。最终 workflow-skills 回归 **55/55 pass**，syntax check 与 `git diff --check` 均 exit 0。
- **accepted**：当前 repo-local Workflow v1.1 Skill 字节已通过本票定义的真实端到端链路，包括连续 ticket-design→implementation、fresh full、finding→fresh focused、fresh recovery、ground-truth Acceptance、docs/closeout evidence、observation wait 和 standalone implement 兼容。主 fixture 创建后到 `2032fcf` 没有 `.workflow/skills` 字节变化；后续提交仅修 Acceptance helper/测试/说明。
- **stable**：**未证明。** 本票不提供长期、多项目、多天运行稳定性结论；后续真实日常使用中的 drift / outage / 长期可靠性仍按实际事件记录，不由本次 Acceptance 自动升级。

正式启用范围限定为上述已验收的 Workflow v1.1 行为与 repo-local source；本票不隐含新的 protected/global Skill apply，也不重复已经完成的历史 apply/verify。

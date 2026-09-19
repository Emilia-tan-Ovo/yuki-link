# WORKFLOW-006 最小端到端 fixture

只运行一条主链；standalone 支线复用 `review-fixture.mjs create standalone`，不重跑 004 的八场景矩阵。`end-to-end-fixture.mjs` 只准备输入/注入/保存中断现场/核验产物，不调用模型、选择 Review mode、伪造报告、操作真实 YCA 或安装全局 Skills。所有 helper 路径均相对本 source checkout，以下命令从该 checkout 执行；`<root>` 是 create 返回的独立临时 Git 仓库。

## 1. 准备与连续实现

```text
node tools/workflow-skills/fixtures/end-to-end-fixture.mjs create
```

可选 `create <parent-repo>` 供自动测试在临时父仓库运行；Skill 始终复制 helper 所在 checkout 的 `.workflow/skills`，不是 parent 的副本。返回 root/entry/ticket/fixed_point。`.local/case.json` 记录 source commit、完整 Skill 字节与控制文件摘要；运行时只写 parent 下 `.local/workflow-fixtures/end-to-end-006-*`，不自动清理。helper 创建 fixture baseline commit，prepare 脚本实际执行一次，receipt/count 是**可控 fixture 事实**，不是生产 YCA 事件。主仓库无提交/安装副作用。

Emilia 开一个无历史的 implementation session，仅提供 root、entry、Ticket 与授权：“通过公共入口完成 ticket-design 后继续 implement；review_policy: delegated，接收方 Emilia；仅本 fixture 测试/本地 commit/handoff，到 Review 前停止”。保持设计与实现同一真实 session/thread。Ticket 初始没有 Notes；测试初始缺 result，生成 14 后转绿。不要把本操作说明或预期 mode/finding 作为受测 Agent 提示。普通 Agent 不修改控制输入/测试/Skills，不编辑 `.local/case.json`。

```text
node tools/workflow-skills/fixtures/end-to-end-fixture.mjs check-implementation <root>
```

此检查重新执行 fixture 测试，核对 Notes/handoff、checkpoint review/当前 HEAD、一次性 receipt、干净的本地提交和 Skill 身份。stdout 含完整 subject，保存本机文件，不塞入模型聊天。成功只为 `artifact-check-passed`；所有 check 的 `behavior_acceptance` 均保持 `pending-external-trace-review`。

## 2. 一次注入、真实 full 与中断

```text
node tools/workflow-skills/fixtures/end-to-end-fixture.mjs inject <root>
```

前置是上步实现交接已齐备；只把 `policy.json` 的 guest_private 改 true 并 stage。`.local/injection.json` 保留前后完整 subject/实际红绿测试及旧绿证据失效声明。重复 inject 拒绝；若命令只留下 pending，保留现场核对，不重试变更。helper 不创建 finding。

Emilia 用显式最小证据包启动 fresh reviewer，从 engineering-workflow 进入 review-change，检查实际权限 diff（Ticket 的 low hint 不能降级），实际执行 full 双轴独立 Review。报告放 fixture `.local`，完整报告/索引须引用两个真实轴及受审 subject；将真实权限 finding 统一标识为 F1，保留原 reviewer ID 映射。若没有发现该违约行为，本条验收失败，不补造成功报告。

Emilia 根据报告保存 fixture checkpoint：`phase: implementation`、当前 `head`、`# Open findings / blockers` 中的 `F1 open`/原报告引用、`# Next action` 修复 F1 后 focused，以及 side effects/真实 run 查询引用。真实原 run 必须 terminal，或继续观察而不能并行重启。

```text
node tools/workflow-skills/fixtures/end-to-end-fixture.mjs interrupt <root> .local/full-review.md
```

report 参数是实际报告/双轴索引的非空本地文件；helper 不判断文本语义。它保存 `.local/interruption.json` 和原 checkpoint，仅令缓存 `head` 回到 fixture baseline；phase/finding/next action、Git diff、原报告、receipt 保持不变。重复 interrupt 拒绝。结束原观察/对话并记录 external interruption，不停止真实 run。此命令只模拟文档现场，真实对话切换由 Emilia 实际完成。

## 3. Fresh 恢复与局部修复

另开完全无历史 session，仅给 root、entry、Ticket 和授权：“从持久化产物恢复，先核验动态事实并交接恢复检查，再继续修复”。不要传前轮聊天、期望 phase 或旧 HEAD。先核对实际 Git/报告/receipt/run，更新缓存 HEAD；保持已有 finding/next action/side effects 正文。Emilia 在**修复前**执行：

```text
node tools/workflow-skills/fixtures/end-to-end-fixture.mjs check-resume <root>
```

核对恢复前后 subject、原报告哈希、phase/F1/next action/side effects 与 receipt/count；保存 stdout 和 checkpoint 快照。检查前不改 tracked 产物或修复权限；本检查是边界字节核对，不是通用 Markdown 语义解析器。此后沿用这个恢复 session 修复 F1、测试、handoff/获准的本地 commit，F1 只能先标 fixed。Emilia 另开 fresh focused reviewer，携带原双轴报告、修前 `.local/injection.json` subject、修后 subject/差异和必要测试；只核对该 finding 与直接回归，verified 后才进入 acceptance。原 full 未变范围保留，不重跑。

## 4. Ground truth、归档与 evidence

Emilia 对照 Ticket 13 条 AC，从实际命令/退出码、Git、原报告和 tool trace 核验。`.local/closeout-input.json` 是 005 schema 的 **pending 模板**；刷新 head/观察时间与已核验的 summary、sources、sessions/runs/model/reasoning、metrics、F1、interruption，缺失值不编造。先固定修后业务内容基线，再准备 docs-only 验收记录与 archive 增量。

按 fixture 内 `.workflow/skills/engineering-workflow/closeout-archive.md` 执行现有 `observe <root> <input>`，保存 stdout 到 `.local/closeout-snapshot.json`，再 `generate <root> <snapshot>`。不替换生成器，不把 raw 放进输入摘要。fixture checkpoint 交接 closeout 后执行：

```text
node tools/workflow-skills/fixtures/end-to-end-fixture.mjs check-closeout <root> .local/closeout-snapshot.json
```

在 archive 提交前执行；snapshot HEAD 必须仍为当前 HEAD。checker 仅验证阶段已记录、有来源引用、测试/receipt、archive 身份与体量、raw 哨兵不泄漏/未改和 `.local` 不跟踪。它**不验证 sources 语义、真实 Agent 隔离或完整 archive 内容一致性**。Emilia 另用一次 fresh evidence Review 核对纯文档/closeout 增量及生成回执/内容摘要，引用此前 full/focused，不以 evidence 重新覆盖业务代码。生成成功或 checker 通过不等于 acceptance。这里的 archive 是临时 fixture 产物，外层 006 closeout 仍按上层授权执行。

## 外部观察最小清单（原始证据均留 `.local`）

Emilia 保存一个精简观察索引；每项含具体 trace/命令文件、观察时间、受检 HEAD/subject、结果/未完成事项。未知保持 pending：

- 公共入口与实际 Skill 路径；design/implement 相同 session/thread；边界 checkpoint 快照，不把普通命令记录写回 checkpoint。
- full coordinator 和两个轴的真实创建参数/ID，均不继承实现历史；F1 报告/原始 ID 映射；修复与 fresh focused 的隔离/verified 证据。追查实际调用，不能只看报告自述。
- external interruption 前后的 run terminal 查询、fresh 恢复创建参数、动态事实读取；check-resume 输出；trace 中未重复实现/full/prepare，effect count=1。报告未变本身不能证明没调用模型。
- 实际 YCA 必要 run 的 `timeout_ms: null`；cursor 连续的 events → 一次短 wait_elapsed → 同 run 后续进展 → terminal。通常 `codex_get_output(wait_ms=60000)`；短窗口只用于必需 elapsed 观察，不转成高频轮询、不另起研究 run。
- 同一观察时间窗的实际 wait/status/output 次数和耗时；对照“窗口长度 / 有来源的旧轮询 cadence × 每轮调用数”的明确**估算值**，给出减少量/比例，不能标为实测历史。cadence 来源或实际记录缺失则 AC11 pending，不任意设阈值或扩矩阵。已有关联真实部分证据可经身份核验后复用。
- archive 生成回执、原始来源/字段一致性、无 raw 入 Git；fresh evidence 只审文档增量。能力分为 implemented / accepted / stable，长期 stable 未证明。
- 另用现有 `review-fixture.mjs create standalone` 和其 README/check；不传 delegated policy，核对真实首次完整双轴发生在 commit 前。使用其已有 observation 格式，不增加 006 副本。

自动测试 `node --test tools/workflow-skills/test/end-to-end-fixture.test.js` 使用 synthetic 产物和报告，仅验证 checker 的成功/拒绝路径及与 005 公共脚本的连接；不启动任何 Agent/YCA，不勾选本票 AC。

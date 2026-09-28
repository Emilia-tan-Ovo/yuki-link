# COMPANION-007 — 一次确认，连续推进授权内工作到 PR

Ticket：[GitHub #132](https://github.com/Emilia-tan-Ovo/yuki-link/issues/132)。Source Spec：[GitHub #125](https://github.com/Emilia-tan-Ovo/yuki-link/issues/125)，US17–23 / US28 / US32 / US34、ID05 / ID06 / ID08、AC06 / AC07 / AC08 / AC13 / AC14。

设计基线：`094b049cc733e0891af262a721370cb203c79260`；branch：`codex/companion-007-continuous-to-pr`；worktree：`C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/companion-007`。

状态：fresh ticket-design 已收口；implementation delta 已写入本 worktree，尚未 Review/Acceptance/真实 E2E。`PRODUCT_DECISION_REQUIRED: none`。接口、Schema、接线与测试 seam 依据 #132 的明确委托决定；没有新增产品行为。当前文件是 canonical implementation-design artifact；#132 是产品范围来源。

## Implementation Notes

### 1. 基线事实与必须补齐的 seam

| 现有入口（均相对仓库根） | 已核对事实 / 本票影响 |
| --- | --- |
| `tools/codex-session-bridge/src/orchestration/companion-dispatch.mjs`：`actionFor/preflight/authority/dispatch` | 005 只消费 `initial-dispatch`，用 `desiredPhase` 与当前 phase 精确匹配；claim 冻结 launcher input，重复调用只读 reconcile。receipt 的 PR 恒为 unknown。不能反复调用它假装跨阶段推进。 |
| `tools/codex-session-bridge/src/orchestration/companion-preparation.mjs`：`prepare/finalizeDesign/get/authority` | 006 已拥有 Issue/worktree/Harness bootstrap、设计启动、canonical Notes/mirror 与分层 readiness；authority 仅限 ticket-design。`get()` 仍比较设计时 Workflow revision，worktree inspector 仍比较 frozen OID；不能把这些启动前提当所有后续动作的永久 gate。 |
| `tools/codex-session-bridge/src/orchestration/workflow-agent-launcher.ts` | 六种 action 已存在；implementation/review 委托原 launcher，其他 action 走同一 ExecutionOperations。finding action 目前只带一个 `finding`，拒绝 caller 的 broad references/current_delta；finding-fix prompt 目前还要求模型 commit。 |
| `tools/codex-session-bridge/src/orchestration/execution-operations.ts` | 唯一模型 reservation/request fingerprint/guarded dispatch/binding/reconcile 所有者；bound 不等于 run completed。unknown runtime 继续占用模型线；reconcile 只读，不补 start/bind。 |
| `tools/codex-session-bridge/src/harness/workflow.ts`、`workflow-model.ts`、`workflow-source.ts` | Workflow 是完整 snapshot + CAS revision + source assessment，已有双轴 Review、finding、Acceptance、closeout。`summary().acceptance.accepted` 要求适用 Review 链与逐 AC 证据；不是 `acceptance.status=passed` 即通过。记录 API 不自动生成事实，不是任意文本结论的认证器。 |
| `tools/codex-session-bridge/src/orchestration/context-assembler.ts` | `prepare_ticket_resume` 给只读建议；requested action 来自 caller，不会自主选择下一阶段。当前 implementation readiness 的 OPEN_FINDING 会阻挡普通 implementation，不能把整个 readiness 强行放宽以跑 finding-fix。 |
| `tools/companion-desktop/backend/engineering-coordinator.mjs`、`worker.mjs`、`yca-engineering-client.mjs` | 确认后只调用一次 DSH dispatch 或 006 prepare；refresh 是观察，没有持续 stage-boundary driver。它们不得存第二份可推进 phase。 |
| `.workflow/skills/engineering-workflow/closeout-archive.md` | 已有确定性归档 helper，仅生成证据摘要，不创建 PR、不认证 Acceptance；目前没有可直接复用的 durable PR-create composite。 |

前置 Notes：`docs/implementation-notes/COMPANION-006.md`，#130 的 Implementation Notes / [PR #149](https://github.com/Emilia-tan-Ovo/yuki-link/pull/149)，以及 `docs/implementation-notes/ORCH-002.md`、`ORCH-003.md`、`ORCH-004.md`、`ORCH-006.md`、`ORCH-007.md` 的 authority/execution/recovery/launcher 决定。历史验收只作为继承证据，不能替代本票入口到真实 PR 的验收。

### 2. 单一工程事实、授权和 next action

**新增的是 Companion 的连续交接 Module，不是通用 phase engine。** 在现有 YCA orchestration 层增加 `CompanionContinuationService`，对外仅提供 `advance(locator)` 与只读 `get(locator)`；内部将可信事实映射到既有 capability。建议公开名 `advance_companion_engineering` / `get_companion_continuation_receipt`，输入只有版本与 `card_store_id/card_id/revision`。不接受 caller 的 phase、next action、authority、model、cwd、permissions、Git 命令、PR 参数或任意结果 JSON。

事实责任保持唯一：

- **授权 source**：EngineeringCardStore 的 immutable confirmation/content digest + 005 claim 或 006 preparation binding + 服务激活的 versioned policy。endpoint 从该确认回读；`desiredPhase` 是入口意图，不是后续循环游标。checkpoint、模型报告、DSH 文本和 policy 单独都不能授予权限。
- **工程 source**：当前 Harness Workflow snapshot/assessment、checkpoint 文件、canonical Notes、真实 Git subject、Review/finding/Acceptance 证据。continuation 只通过原 `harness.recordWorkflow` 写完整快照，沿用原 phase 枚举；finding-fix 属于 implementation，focused-review 属于 review，PR 交付属于 closeout，不新增 phase。
- **执行 source**：ExecutionOperations + exact Runtime request + run/binding。continuation 不调用 `manager.start/resume/attach/bind`，不复制执行状态机。
- **外部副作用 source**：机械动作的 durable intent/receipt 与 Git/GitHub 实际对象，参见下文；卡片投影不是事实源。
- **next action**：continuation 每次从以上 source 重新计算的 action-specific 派生值，携带 Workflow revision、subject identity、evidence refs、`ready/blocked/unknown/unsupported` 和 reason。它不持久化为可独立驱动流程的 phase；checkpoint 的 Next action 只是恢复导航。

选择优先级固定为：先核对已接收 request/未知副作用 → 观察 active run/task → 收集上一动作的可验证结果并完成边界记录 → 检查 endpoint 是否已达 → 选择最早缺失的既有能力 → 再核验当前动作 authority/readiness → 执行至一个异步等待点。不是按 phase 字符串自增；已有且适用的产物不会重做。

`design-only` 和 `to-pr` 使用同一个 selector、同一设计完成谓词。前者在设计证据成立后返回 `endpoint_reached`，implementation readiness 为 unsupported；后者才有资格派生 implementation authority。`to-pr` 终点要求真实匹配的 PR 回执及对应受验收内容；不消费卡片中的额外 merge/deploy 字段，不产生 merge/deploy/production restart action。

### 3. 持续驱动、身份与 durable 边界

- 005 initial dispatch 与 006 preparation 继续拥有其已有副作用；接收时把同一 confirmed work 关联到 continuation，已有 design operation 作为起点，绝不另起一个 design。两类入口之后汇入同一 selector。006 bootstrap 的重复调用只能采用原产物。
- 在 EngineeringCardStore 的既有 SQLite 做 additive migration：保存唯一 confirmed-work 关联，以及**交接/机械动作 intent 与回执**。字段包含 confirmation identity、binding refs、action purpose、predecessor evidence identity、冻结 payload/digest、稳定 request/operation/task refs、attempt receipt、unknown 原因。没有 `current_phase`、第二个 run status 或独立 acceptance bool。执行状态仍实时查 ExecutionOperations/Workflow。
- action slot 由 confirmed-work + capability purpose + 原始产物身份确定；primary review、同一 origin review 的 finding batch/focused verification、PR delivery 都有语义唯一槽位。不能仅用最新 Workflow revision 生成新 slot，否则一次 checkpoint 更新就能重复启动 reviewer/PR。slot 内冻结本次 Workflow revision/内容/authority；相同请求 changed payload 必须 conflict。
- `advance` 在短 SQLite CAS 内取得本次 intent 写入权；完成持久化后才调用能力。网络 await 不持有数据库事务。单进程使用 per-work serializer，跨连接仍靠唯一约束/CAS；不能仅靠内存 `busy`。
- YCA 托管唯一 wake driver：确认接收后持续观察已知 run/owned task，使用现有 Runtime output/subscribe seam；终态唤醒同一个 `advance`，同步机械交接完成后再计算下一动作。等待不占一个 DSH 推理回合。启动时只枚举已登记 continuation，先 reconcile，再订阅；不扫描全部旧 confirmed 卡偷偷升级执行。
- DSH/Emilia 仍通过 Companion 专用高层入口交给 YCA；DSH 不再靠“再说一句继续”驱动每个普通阶段。新需求准备入口同样在既有 DSH 专用 composition 中接通 prepare/advance；Desktop coordinator 只负责可信确认、一次交接及 typed receipt 展示。状态查询保持只读，关闭聊天、UI refresh 或 DSH exit 不触发新的工程派发。
- 新旧工具兼容：005/006 的旧只读 receipt 与 identical retry 保持原语义；新增 continuation 投影链接原记录。旧 accepted operation 可以读回，不能把旧 payload 改成新连续请求。新功能激活不自动消费历史未接收卡；既有确认若要接续，由显式高层调用核实完整授权及既有产物，不要求普通阶段重新确认。

### 4. Completion / readiness：可信 producer 与证据

阶段报告是**候选结果**。为现有 launcher 的 prompt/handoff 增加窄的版本化结果文档约定（建议 `.local/workflow-artifacts/<ticket>/<action-slot>/result.json` + 报告引用），由服务在启动前确定目标路径，并将约定/引用纳入保护性 prompt digest。模型只写结果产物，不写 authority、卡片 store、execution receipt 或接受结论。

候选结果至少描述 action、输入基线/产物引用、结论及 blocker；design 明确 `product_decision_required` 和未决项；Review 保留 mode、Standards/Spec 两轴、原 finding ID 与 evidence；fix 只报告 fixed/unverified。身份、operation/run、真实权限和内容 digest 均由 YCA 外部观察绑定，不能信任候选自报。模型报告是语义判断的来源，但不能单独证明执行成功、授权或后续阶段完成。

continuation 的 evidence adapter 校验 schema、预定路径及 byte digest、原 operation 的 action/destination、真实 run 终态、产物与当前 Git/范围的关系；Review 再核对 fresh child/isolation 与原报告。自由文本中的“已完成”、DSH exit 0、空 findings、Context Plan 语法通过、仅有 Notes 文件都不能直接推进。缺少或矛盾结果先按原 run/产物查找；查不清保持 incomplete/unknown，不启动一个模型替它“证明完成”。

| 动作 / 边界 | 必须核实的完成证据 | 下一步责任 |
| --- | --- | --- |
| ticket-design | 原 design operation/run 成功终态；canonical Notes/Context Plan 回读；未决产品项为空；Notes 与 confirmed Ticket/Spec 范围一致；006 mirror bytes/digest 一致，无 unknown side effects | YCA design-evidence adapter 建立设计完成证据。design-only 停止；to-pr 做下一节可信 authority 交接 |
| implementation | fresh Main run 终态、Implementation Handoff、实际 diff/文件集合、最小测试的可定位报告；测试通过声称须有实际命令/task 退出与受测内容证据 | Emilia + YCA 执行所需 full suite/核对/限定写集 commit，冻结提交后的 review subject；创建 pending primary Review 记录并启动原 review launcher |
| primary Review | 真实 fresh Review child、终态 run、完整两轴报告、当前 subject/ref/identity、适用性；Review report 与实际关联一致 | 记录原 reviews/findings。无 finding 且通过 → acceptance；有 finding → 窄 fresh fix；incomplete 不冒充 pass |
| finding-fix | fresh Main fix run 终态、原 finding IDs、fix baseline、实际 fix diff 与必要定向测试；只能写 fixed-unverified | 机械验证/commit 后冻结最终 fix subject；创建一次 pending focused Review，启动原 typed action |
| focused-review | fresh child 与原 review/finding batch 关联；修后 subject identity；逐 finding 验证及原两轴未变部分仍适用 | 全部 verified 才可进入 Acceptance；保留原 full Review，两轴不会被 focused 报告覆盖 |
| acceptance | `WorkflowHistory.summary().acceptance.accepted` 为真；每条 AC 有适用的外部证据，Review 链覆盖当前内容；无未知副作用 | Emilia 的确定性 evidence collector 填原 Acceptance schema，再重读 assessment/summary。普通 AC 不启动 acceptance 模型 |
| PR | PR ID/number/url、repository/head/base、远端 head OID、delivery intent 与已验收 subject 一致；真实读回成功 | 写 delivery receipt，投影 endpoint reached；不从 run 或 Acceptance 推导“PR 已交付” |

**Acceptance producer 必须实际落地。** Notes 中的 Test Plan/AC 引用形成有界 evidence obligations：仓库命令/测试、Git/diff、Harness run/binding/Review、产品外部观察。YCA collector 执行或读取既有 owned task/sync-call receipts，记录命令、exit、受检内容/环境及逐 AC 引用；不接受模型给一个 `passed=true`。需要语义解释时保留已有工程报告，但缺外部观察的 AC 仍 not-verified。只在 AC 明确要求 Agent/session 行为时才复用 `acceptance-agent` 和可信 `agent_criterion`，不为普通验收增加模型。命令来源为已落地计划与可信仓库配置，经范围核对执行，不把结果文本作为任意 shell 执行输入。

**正常变更不会永久卡在旧设计状态。** 006 frozen OID 是比较基线和 bootstrap 历史事实，handoff 后当前 HEAD 来自 Git；仓库 common-dir/toplevel/registered worktree/branch/基线身份仍要持续核对。保留设计完成时 revision/run/Notes 的历史证明，但后续 readiness 比较当前 Workflow revision 与新的证据，不要求永远等于 `bindings.design.workflowRevision`。不得修改旧冻结事实来迁就新 HEAD，也不能全局删除 006 的 bootstrap drift 检查。

### 5. design completion → implementation authority

顺序不可交给外层手拼：

1. 回读 confirmed card、005 claim 或 006 binding、canonical Issue identity 与 scope；检查 endpoint=to-pr、准备授权中的禁止项、无新的产品/范围决定。设计完成不是第二次 Owner confirmation。
2. 复用 006 canonical Notes → mirror → 回读的发布规则；给已有 Ticket 路径补同一能力，不能只检查 `issue.body.includes(notes)`。Issue 的产品 scope 与受控 Notes mirror 分开核验，但不得泛化成任意忽略正文区域。
3. **scope digest 兼容**：005 当前 digest 覆盖完整 title/body。保存原确认的完整 snapshot/digest；只允许由 durable mirror intent 证明的、该服务拥有的精确 Notes-block 替换。重建产品正文必须逐字匹配原 snapshot，其余变化要求重新讨论；标题/AC 不被消去。006 对 `bound.body` 的核验继续保留。不能用“去掉所有 Implementation Notes”绕过 scope gate。
4. YCA 从实际 Git、checkpoint 和产物构造下一份完整 Workflow；checkpoint UTF-8 原子写入/回读后，以原 revision CAS 调 `recordWorkflow`，重读 assessment 必须 verified。写入回执未知则查原 request，不覆盖新 revision；文档与 Journal 不伪称跨存储原子事务。
5. 从同一确认 + 设计完成证据 + 当前 Workflow/Git + active implementation policy 派生现有 `ImplementationAuthorization`，精确绑定 Notes path/hash、Ticket、endpoint 允许的 action、确认 provenance、policy digest。source 使用既有 `kind=adapter`；DSH 不传/写这个 snapshot。
6. 冻结新的 action intent/request 后调用 `WorkflowAgentLauncher(action=implementation)`；原 launcher 在 reserve 前与 post-await guard 再读卡片/策略/Workflow/Notes/Git/model-line。policy/source 或观察 TTL 失效时重新核对，不能把 once-ready 当永久授权。

006 的 `finalizeDesign` 当前只识别 run completed + Context Plan，不验证未决产品项；本票在共同 design-evidence seam 补齐上述检查，不把 006 的 ready 原样当 implementation authority。之后 review/fix/focused 的 authority 也按同一办法由 confirmation 与各自产物派生，绝不改写可信配置文件中的逐票 authorizations。

### 6. Finding 收敛、fresh context 与 Owner gate

- 保留既有 review-change 的风险路由与双轴制度；本票实现涉及持久化/授权/外部副作用，应做 fresh full primary Review。当前 `ReviewLauncher` 的公开启动 contract 只接收 pending full Review，本票主链沿用它；不把已有 Workflow 的 evidence/focused 表达能力误称为 launcher 已支持所有 primary mode，也不顺带扩一套风险路由器。
- 同一 primary Review 的 unresolved findings 组成一个有界 batch，统一 fix baseline、原报告与必要受影响路径/规范/最小测试；一次 fresh fix 后，在最后一次修复内容上做一次 fresh focused re-review。不得逐 finding 切换 fix/review 使先前验证在后续修改后过期。
- **最小 launcher 补口**：finding-fix/focused-review 增加受保护的 typed finding batch，沿用同两个 action。兼容旧 singular `finding` 输入；新输入 singular/batch 互斥。可信 authority、protected intent 与 prompt 都覆盖完整 batch；每个 `(origin_review_id,finding_id)` 必须属于同一原 Review，focused pending record 必须覆盖整批。仍拒绝 caller broad references/current_delta；不只验证首个 finding 后在 prompt 偷塞其余。旧 v1–v4 journal/fingerprint 原样 replay；新增可选字段不能默认注入旧记录而改变其 digest，必要的新版本编码由实现按现有协议风格完成。
- 正常自动路径到“一轮 fresh fix + 一次 fresh focused verification”为止，沿用根 AGENTS/engineering-workflow 的成本边界。focused 仍有未解决 finding、证据 incomplete、独立新风险需要升级或反复无进展时，保留具体 finding 与缺口，停止自动加模型；不是每个成功阶段都加 Owner gate。此时状态是无法确认通过/需要新的修复安排，不假报 Acceptance。不同 request ID 不能绕过同一 origin batch 的唯一槽位。
- 真正产品/范围变化明确输出 `PRODUCT_DECISION_REQUIRED` 与具体问题；越过 endpoint 不执行。已核实的配置缺失/未知回执/证据矛盾说明 blocker 和 source。依赖准备、有效模型线等待、正常报告核对、一次正常 finding 修复不要求 Owner 逐阶段批准。
- Git/full suite/GitHub 属于 Emilia + YCA deterministic mechanical actions。Companion 启动的 implementation/fix prompt 必须明确交还这些动作，消除当前 prompt 的模型 commit 指令；通过服务可信 contract/adapter 选择 Companion handoff 方式，不让公共 caller 任意覆盖 legacy launcher contract。普通旧入口的行为保持兼容。
- 每阶段 fresh session；Main Conversation 可持续，session 不复用。finding batch 只带原报告、baseline、fix delta 和窄引用，不继承设计聊天、implementation 对话或完整 confirmed request。模型策略来自已激活 policy：Sol medium 为默认，本票复杂实现可 Sol high；不升级 Astra、不并行第二模型线。

finding 的 action-specific readiness 由同一 selector 对明确的原 batch 核验：当前 OPEN_FINDING 仅对本次授权修复的那些 finding 属于预期输入，不能因此忽略 recording、active/unknown execution、不完整 coverage、未知副作用、stale/conflicted subject 或宿主依赖。普通 implementation 仍被未解决 finding 阻挡。action-specific 判断作为现有 Context facts 与 launcher gates 之间的窄适配，不把 Context 的 `ready` 变成授权。

### 7. PR 和机械动作的 durable/idempotent/reconcile

新增窄 `CompanionDeliveryAdapter`，复用 YCA 的 Git/owned task 能力与 006 GitHub transport 的身份核验模式；实现 PR transport，不让模型运行 `gh pr create`。Git/完整测试/commit/push 的具体操作由该机械接线承担，不能只留接口让 ChatGPT 外层临时补。

- 在 commit、push、PR-create 前分别保存 intent；有稳定 step/request identity、worktree/repository、精确写集或 OID、目标 remote/ref、父内容/验收证据与 payload digest。测试长任务走已有 owned task，保存 task id/退出与内容身份；未知任务先查，不能为了续流程重复开 full suite。
- commit 只接收本票 verified diff，核对 index/parents/tree/明确路径，保留不相关工作。push 只推已冻结分支/OID，不 force，不推默认分支。unknown commit 查 Git 预期 parent/tree 与实际 HEAD；unknown push 查远端精确 ref/OID；冲突保留现场。
- **PR durable intent** 在任何 create 前落盘：delivery id、confirmed card identity、canonical repository identity、Ticket、head repo/ref/OID、base repo/ref及观察 OID、已验收 subject、标题/body bytes digest、creation marker、已认证 actor identity、attempt state。PR draft 属性沿用项目现有 Draft PR 交付惯例，写入冻结 payload，不从模型回复推导。
- 新动作开始前检查相同 delivery slot 和 head/base 既有 PR。已有本次绑定的 PR 只读核对；不相关同分支 PR 视为冲突，不能按标题认领。首次 create 在短 CAS 中写 `attempted` 后才出网；两个 driver 不能同时获得 create 权。
- 成功响应仍须按 immutable PR ID/number 回读，核对 repository、creator、marker/payload、head/base refs、head OID、draft/状态及 Ticket 引用，再保存 verified receipt。GitHub 不提供本地事务级 exactly-once；这里保证不在未知结果后盲目重发。
- **unknown receipt**：重启/超时后先读 intent。已有 ID 按 ID/number 查询；没有 ID 则完整枚举同 head/base 的 PR（含 closed/merged）并精确匹配 durable marker/actor/payload，候选唯一且回读身份一致才采用。0 个、多个、分页不全/网络失败都仍 unknown；marker 只定位，不授权。搜索暂时没有结果不能证明从未创建，禁止换 ID、换标题或再次 create。已关闭/已合并对象仍作为已发生副作用保存，不能另建替代或宣称本服务获准合并。
- 若 transport 能确定请求在发送前已拒绝，可记 `not-attempted/definitely-not-applied`，刷新缺失条件后准备新 attempt；一旦远端结果不确定，只能 reconcile，绝不借过期 lease 自动释放 create 权。
- PR-ready 必须重新观察远端 head、当前授权、Acceptance 的受检 subject 与 Review 链；记录观察时间，不承诺锁住 GitHub 在查询后的所有并发修改。base 的普通前进由既有 Git/diff 适用性检查判断是否需刷新，不能默默换 target/base。内容变化使相应证据失效，不用旧 pass 盖新内容。
- 在 primary Review 前由机械动作提交需交付代码/Notes，冻结 review subject；fix 后同样先 commit 再 focused review，Acceptance 与 PR 对同一最终 HEAD。避免 acceptance 后为了补 handoff 自动产生新实现 commit。closeout 使用现有 helper 生成本地证据摘要；PR 回执先写 ignored checkpoint/delivery record，`.workflow/history` 的后续归档提交不作为本票 PR-ready 的循环依赖，也不悄悄追加未经审查内容到已验收 head。归档 pending 如实记录，不能因此再开模型。

### 8. Stage-boundary 恢复与事实新鲜度

每次 wake/restart/timeout 必须 existing-request-first：先回读 continuation intent → 原 ExecutionOperations/Runtime/owned task → 原 Workflow request/CAS → Git/GitHub 实际对象，再决定是否还有**未执行的新动作**。旧 request 按冻结 payload 查，不依赖当前 policy 可用才能读旧回执。

| 断点 | 必须行为 |
| --- | --- |
| run 仍 active，或 observation wait 到期 | 继续观察原 run，不把 UI/DSH/HTTP 超时当 run 失败；不启动下一模型 |
| 模型 intent 已保存但 operation 不可确认 | 005/ORCH 原语义：unknown/reconciliation-required；not-found 不是未执行证明，不换 request 重派 |
| run 完成，handoff/测试/Workflow 尚未记录 | 收集原产物与机械回执，恢复未完成的边界记录，不重跑已经完成的模型 |
| checkpoint 已换、Workflow append 回执未知 | 用固定 boundary request 与冻结完整 snapshot 查 Journal；已记录则采用，确定未记录且原 revision 仍匹配才补记录，冲突保留现场 |
| Workflow 已前进而 continuation receipt 未落盘 | 由原 request/产物 digest 认领已记录边界；不能按新 revision 创建第二 action slot |
| PR create / push / mirror 回执未知 | 只做对应外部 reconcile，不能让重新 DSH turn 重放副作用 |

只读 reconcile 不扩为自动 bind/resume primitive。副作用确定未发生且确认仍有效时才允许准备新 attempt；政策/Notes/环境 drift 属于重核对，不自动要求重确认，产品 scope drift 才转 Owner。无法判断新旧内容归属时 fail closed。

同一 boundary 的文档写入、Journal 与 card-store 不是原子事务：持久化预期 snapshot/digests/request 后，原子替换 checkpoint，CAS record，最后保存成功 revision/event/cursor。发生冲突不覆盖另一 writer 的 checkpoint，优先保留两方证据并协调。动态事实变化在相应边界刷新：Git 每个 handoff/副作用前；run 每次 wake；policy/确认每次 new action 及 launcher guard；Issue/mirror/PR 每次相关动作及 TTL 到期；tests/Review 依受检内容失效。

### 9. 展示与成本

同一 typed continuation receipt 并列提供 endpoint、派生 next action/readiness、原 preparation/dispatch refs、当前 operation/run、Harness Main/Review refs、Workflow/Acceptance、PR delivery 与 source/observed_at。Desktop 只投影这些事实，移除“to-PR 后续连续推进尚未接入”的固定文案；design-only 到终点显示设计已交付，不显示整票 Acceptance passed。DSH turn completed、run completed、Acceptance accepted、PR delivered 始终分开。

每个模型终态从 durable usage 汇总 run 数、input/cached input/output、实际 model/reasoning；DSH turn 数单独统计，不能只数 Sylvia。写 checkpoint `model_usage` 后再准备下一个模型动作，unknown 原样记录；异常依据根 AGENTS 的参考目标诊断，不按固定 token 数自动熔断。记录确认→接收、首 DSH 回应、阶段交接、终点回显时间和重复派发计数；不为机械 wake 增加模型。single model line 的最终仲裁仍是 ExecutionOperations 的 runtime coverage/guard；driver 的串行化不能替代该门禁。

### 10. 拟修改写集与实现顺序

| 写集 | 内容 |
| --- | --- |
| 新增 `tools/codex-session-bridge/src/orchestration/companion-continuation.mjs`、`companion-evidence.mjs`、`companion-delivery.mjs` | 小公共 Interface；内部 evidence selector、authority adapter、机械 delivery seam。按职责拆分，不建立通用 scheduler/policy DSL |
| `tools/companion-desktop/backend/engineering-card-store.mjs` | additive durable handoff/action/delivery intents，唯一槽位/CAS；保留 v1–v3 卡片历史，迁移不启动任务 |
| `tools/codex-session-bridge/src/orchestration/companion-contract.mjs`、`companion-dispatch.mjs`、`companion-preparation.mjs` | confirmed-work 交接、现有 bootstrap/finalize 复用、作用于当前动作的 readiness、历史基线与当前 subject 分离 |
| `tools/codex-session-bridge/src/orchestration/workflow-agent-launcher.ts`、`implementation-launcher.ts`、`review-launcher.ts`、`tools/codex-session-bridge/src/harness/execution-model.ts` | 结果文档约定、可信 Companion mechanical handoff、finding batch 与保护性兼容；不重写 ExecutionOperations 生命周期 |
| `tools/codex-session-bridge/src/orchestration/context-assembler.ts`、`harness-context-source.ts` | 只在 finding action 的 action-specific readiness 接线确有需要时修改；普通 implementation 有 open findings 继续拒绝，不能全局消除 blocker |
| `tools/codex-session-bridge/src/main.js`、`mcp.js` | continuation 生命周期/wake、专用 MCP capability 与 schema/安全错误投影；复用现有可信 card-store/policy/config 激活，不读写生产配置 |
| `tools/companion-desktop/backend/engineering-coordinator.mjs`、`yca-engineering-client.mjs`、`worker.mjs`、`backend/dsh/runner.mjs`、`backend/dsh/companion.patch.yml` | 一次确认后交给高层 continuation；专用 DSH composition 接线；typed status，兼容已有 confirmed dispatch，不按每阶段启动 DSH |
| `tools/companion-desktop/desktop/renderer.js` 与相关 tests | 展示 endpoint/真实阶段/Acceptance/PR/具体 blocker，保留现有卡片 UI 与聊天生命周期 |
| `tools/companion-desktop/backend/github-issue-source.mjs` | 仅在现有 Ticket 的 Notes mirror/scope adapter 需要时补精确受控变换核验；不弱化整个 scope hash |
| 新增 `tools/codex-session-bridge/test/companion-continuation.test.ts`、`companion-delivery.test.ts`；下述既有测试与相关 README | 公开 seam 的必要确定性覆盖、接入说明；无依赖升级需求。若现有 config 不能表达 mechanical adapter，才补 `tools/control-center/src/config.js`、`units.js` 及配置测试，不改用户真实配置 |

顺序：确认/旧记录兼容与 action identity → evidence/设计到实现可信交接 → 单 wake driver + 既有 launcher/Review/finding batch → deterministic Acceptance/PR delivery → Desktop/DSH 回显 → 定向验证与 handoff。低风险 deferred details 只有内部 DTO/helper 名称、兼容版本编码和测试文件拆分；authority producer、恢复语义、PR unknown gate 及 finding 收敛不可留给临场发挥。

## Deterministic Preflight

本设计 run 的实际观察：HEAD 与 fixed point 相同，branch 正确，起始 `git status --short` 为空；本 worktree 没有 COMPANION-007 checkpoint，`.local/workflow-state/COMPANION-007.md` 被 Git 忽略。`pwsh.exe`、Git、gh、rg 可用，Node 为 `v24.18.1`；`tools/codex-session-bridge/node_modules` 与 `tools/companion-desktop/node_modules` 均不存在。GitHub #132/#125/#130/#131 与 PR #149 已只读取得。未探测生产服务、读取凭据或运行模型 E2E。

fresh implementation 启动前由 Emilia + YCA 完成 0-token preflight：

- 重读本 Notes、#132 与所指 Spec 范围；核对 worktree、branch、fixed point/HEAD、仅本票文档 delta、Notes digest。不要复用 006 worktree/session，也不要重新登记已存在 Harness Ticket。
- 用项目现有确定性方式准备本 worktree 的 bridge/desktop 依赖，核对 Node/Git/pwsh 及测试工具；本轮不安装。测试命令按各 package 的 cwd 执行。
- 核实 trusted card-store、006 binding、统一 launcher、policy/model/native permissions、Harness recording/runtime coverage；只有随后真实 E2E 才需要激活隔离运行环境及已授权凭据引用，不能拿当前生产进程做实验。
- 明确 full suite/commit/push/GitHub adapter 的 YCA 执行责任和 owned task 入口、报告摘要位置；确认无另一活跃模型工作线。
- 更新 checkpoint 的真实 design run/usage；本 run 目前无法取得 durable usage，记 unknown，不由模型估算。复杂实现建议 fresh `gpt-6-sol high`；模型启动由 Emilia 执行，本设计不启动下一模型。

## Acceptance Evidence Plan
```json
{
  "schema_version": 1,
  "issue_ref": "https://github.com/Emilia-tan-Ovo/yuki-link/issues/132",
  "criteria_sha256": "bbb02cf53cce44cb7d53c12ef3d0a97c0e106f8a4981fdb5c8d2d14301f70754",
  "criteria": [
    {"criteria_ref":"AC1","text":"确认目标与终点后常规阶段连续推进；只设计样例不实现，授权到 PR 样例交付真实 PR，不擅自合并/部署。","source_kind":"external-observation"},
    {"criteria_ref":"AC2","text":"沿用 006 的准备及授权交接，不退回 ChatGPT 人工预制工程状态；每一步根据既有事实选择对应能力，不另存一套竞争工程 phase。","source_kind":"harness-run"},
    {"criteria_ref":"AC3","text":"fresh 实现/Review 及必要修复遵守既有协作规则，原 Harness Main/Review 分离、运行归属、diff 与结果继续可查。","source_kind":"agent-session"},
    {"criteria_ref":"AC4","text":"产品/范围实质变化或无法确认的状态才说明具体阻碍；常规准备和核对不制造新的逐阶段 Owner 批准点。","source_kind":"external-observation"},
    {"criteria_ref":"AC5","text":"一条受控代表性任务从确认到终点可复核，正确区分 run 完成、验收完成和 PR 交付。修复路径用必要确定性样例覆盖，不为凑流程特意制造一次真实 finding。","source_kind":"external-observation"}
  ]
}
```

本块绑定 #132 Issue 原文的五条 checklist；`criteria_sha256` 是按顺序排列的 `{criteria_ref,text}` JSON 的 SHA-256。Notes 改动后重新读取完整文件 digest；设计结果的 `acceptance_plan` 仅为候选，不能降低本块证据要求。真实外部观察缺席时对应 AC 保持 not-verified。

## Test Plan

确定性测试穿过公开 Companion 入口，使用真实 card SQLite、Harness Journal/Workflow/ExecutionOperations、launcher 和本地 Git fixture；只替换外部 GitHub transport、实际模型 spawn、耗时测试/外部设备 transport。禁止用 fake 整个 preflight/Workflow/Acceptance 返回 ready/passed 来证明闭环。

1. **同一确认，两种 endpoint（AC1/2/4）**：复用 `tools/codex-session-bridge/test/companion-preparation.test.ts` 的 no-ticket bootstrap，服务自己产生所有边界 snapshot/authority；设计产物到齐后 design-only 无 implementation/PR 调用，to-pr 自动接 implementation→review→deterministic acceptance→PR；测试中不手工注入预制的后续 Workflow。已有 Ticket initial-dispatch 作为同一 selector 的最小入口回归。
2. **证据与授权（AC2/3/4/5）**：一个参数化测试覆盖 DSH exit/只有 run completed/只有 Notes/未决产品项/镜像不一致/旧 subject 不足以推进；正常 Notes mirror 不误判产品 scope drift，真正 AC/body 变化拒绝新动作。正常 HEAD 与 Workflow revision 前进不被 006 旧设计绑定永久挡住；post-await authority/内容变化复用 launcher gate 回归。
3. **Finding batch（AC3/5）**：同一 primary 的两个 finding，一次 fresh fix + 一次 fresh focused，验证整批 IDs、最终 subject、窄 prompt、Main/Review 分离和原双轴保留；未全部 verified/incomplete 或换 request 企图再跑 focused 时不循环。无 findings 正常跳过这两次模型。
4. **一个 stage-boundary 恢复样例（AC2/3/5）**：原 run 已完成、Workflow 已写但 continuation 回执丢失，重开服务→原 request reconcile→恰好一次下一动作；重复 wake/并发 advance 不增加 run。另用现有 005 claim-without-operation 样例确认 unknown 不自动重派，不扩 ORCH crash matrix。
5. **PR unknown（AC1/5）**：外部 create 成功、本地回执丢失，重开采用同一个唯一 PR，create count=1；同一测试参数化 0/多候选/查询不全保持 unknown。freeze head、wrong repo/head/payload 与重复 delivery slot 不通过；观察/展示失败不重做 commit/push/PR。
6. **入口/展示契约（AC1/3/4/5）**：真实 `/companion-mcp` → Desktop client 解码保留 typed code/source；confirmed 只启动一次 DSH handoff，普通阶段无新增 Owner confirm 或 DSH turn；UI 分开 DSH/run/Acceptance/PR，关闭聊天不丢失 YCA 已接收工作。旧 SQLite/launcher/receipt 兼容沿用既有测试。

直接回归入口：`tools/codex-session-bridge/test/orchestration-companion-dispatch.test.ts`、`orchestration-companion-mcp.test.ts`、`workflow-agent-launcher.test.ts`、`implementation-launcher.test.ts`、`review-launcher.test.ts`、`orchestration-execution.test.ts`、`harness-workflow.test.ts`；`tools/companion-desktop/test/engineering-coordinator.test.mjs`、`engineering-cards.test.mjs`、`dsh-runner.test.mjs`、`renderer.test.mjs`。实现者仅执行改动直接驱动的定向子集及必要 typecheck；完整 suites/build/package 由 Emilia + YCA 按实际写集执行并返回计数/退出/必要失败片段。

**唯一 representative real E2E：**由 Emilia 在隔离受控 repo/worktree/root/runtime 下，从一条无预制 Ticket 的小需求创建 to-pr 卡，Owner 只确认一次（包含 006 Issue/worktree 准备授权及 to-pr 终点）。真实 Desktop/DSH→YCA preparation→fresh design→fresh implementation→fresh primary Review→确定性 Acceptance→真实 Draft PR；没有 finding 就不制造 finding，也不为了验收重跑模型。design-only 用上述确定性样例及已有真实 design evidence 复用，不追加第二套模型 E2E。

该 E2E 保存 confirmation/preparation/continuation IDs、原生 operation/session/run/权限/usage、Main/Review 隔离、Notes/mirror、diff/测试与逐 AC 证据、PR immutable identity/head/base/读回、各段耗时和实际 DSH/Codex/重复派发计数；对同一已接收 action 做一次确定性重复查询即可验证 identity 不变。报告 run completion、Acceptance completion、PR delivery 分别成立；不 merge/deploy/restart production。凭据/外部环境缺失则明确 pending，不以 fixture 替代真实 PR。实际 E2E 授权与隔离准备由 Emilia 在实现后处理，本设计 run 不执行。

## Out of Scope

- 不进入 COMPANION-008/#133：不做任意任务查询/stop/pause、跨端恢复 UI、消息投递重试或微信；仅实现本票 stage boundary 必需的 reconcile。
- 不新增通用 workflow engine、competing phase、多 Agent 并发、批量自治、policy DSL、模型记忆系统、第二 Codex 派发者或新的 Review 制度。
- 不用模型循环跑 Git/full suite/GitHub，不扩 fault/压力/drift 矩阵，不故意制造真实 finding，不升级依赖或重做 UI。
- 本轮不修改实现代码，不 commit/push/PR/merge/deploy/restart production，不读取/更换密钥，不修改项目外配置。设计就绪不代表代码已实现、E2E accepted 或长期 stable。

### Context Plan

- **Core:** GitHub #132 与本文件全部决定；根 `AGENTS.md`、`CONTEXT.md`、`.workflow/skills/engineering-workflow/SKILL.md`；fixed point `094b049cc733e0891af262a721370cb203c79260`；`tools/codex-session-bridge/src/orchestration/companion-dispatch.mjs`、`tools/codex-session-bridge/src/orchestration/companion-preparation.mjs`、`tools/codex-session-bridge/src/orchestration/workflow-agent-launcher.ts`、`tools/codex-session-bridge/src/orchestration/execution-operations.ts`；`tools/codex-session-bridge/src/harness/workflow.ts`、`tools/codex-session-bridge/src/harness/workflow-model.ts`、`tools/codex-session-bridge/src/harness/workflow-source.ts`；`tools/companion-desktop/backend/engineering-card-store.mjs`、`tools/companion-desktop/backend/engineering-coordinator.mjs`；`tools/codex-session-bridge/test/companion-preparation.test.ts`、`tools/codex-session-bridge/test/workflow-agent-launcher.test.ts`、`tools/codex-session-bridge/test/harness-workflow.test.ts`。
- **Related:** Source Spec #125 US17–23/US28/US32/US34、ID05/06/08、AC06/07/08/13/14；`docs/implementation-notes/COMPANION-006.md` 的 preparation/readiness；GitHub #130 Implementation Notes / PR #149 的 confirmed dispatch/原文不授权；`docs/implementation-notes/ORCH-002.md`、`docs/implementation-notes/ORCH-003.md`、`docs/implementation-notes/ORCH-004.md`、`docs/implementation-notes/ORCH-006.md`、`docs/implementation-notes/ORCH-007.md` 仅 execution/launcher/reconciliation 部分；`tools/codex-session-bridge/src/orchestration/implementation-launcher.ts`、`tools/codex-session-bridge/src/orchestration/review-launcher.ts`、`tools/codex-session-bridge/src/harness/execution-model.ts`、`tools/codex-session-bridge/src/orchestration/context-assembler.ts`、`tools/codex-session-bridge/src/orchestration/harness-context-source.ts`；`tools/codex-session-bridge/src/main.js`、`tools/codex-session-bridge/src/mcp.js`；`tools/companion-desktop/backend/yca-engineering-client.mjs`、`tools/companion-desktop/backend/worker.mjs`、`tools/companion-desktop/backend/dsh/runner.mjs`、`tools/companion-desktop/backend/dsh/companion.patch.yml`。
- **Retrieval:** 定向查找 `finalizeDesign`、`bindings.design.workflowRevision`、`findByRequest`、`guardDispatch`、`WorkflowHistory.summary`、`subjectIdentity`、`finding_context_refs`、`OPEN_FINDING`、`recordWorkflow`、`owned-task`、`store.subscribe`；需要报告格式时读 `.workflow/skills/review-change/SKILL.md`、`.workflow/skills/engineering-workflow/recovery.md`、`.workflow/skills/engineering-workflow/closeout-archive.md`；测试入口用上节完整目录前缀检索。其他历史、整份 Spec、聊天与原始日志保持冷读。
- **Expansion triggers:** authority 无法绑定真实确认/产物；006 的正常交接被旧设计 readiness 阻断；batch 保护不能兼容旧 journal；Workflow/Review subject 与最终 PR head 无法对齐；现有 owned task 或 GitHub transport 无法提供 exact receipt/reconcile；这些直接阻塞 #132 AC 时才扩大调查。真实新产品/范围决定输出 PRODUCT_DECISION_REQUIRED；其他相邻问题只记录 follow-up。

## Implementation Handoff

- **实现状态：**timeout 后在保留的 delta 上完成 narrow recovery；产品未决项 none。已接确认卡片持久关联、continuation selector/wake、候选结果证据读取、finding batch、机械 full suite/commit/push/PR intent 与回执核对、MCP/main/Desktop 投影。design-only 停在设计完成；to-pr 的 implementation、Review、Acceptance、PR 各按原 Workflow 与外部事实推进。普通模型 run 完成、Acceptance accepted 与 PR delivered 分层显示，不从上游状态推导下游完成。
- **本次恢复修正：**公开 Companion MCP continuation 路由及 Desktop typed code/source；只读 get 不写 PR 回执，advance 先 reconcile 原 intent；已匹配但未落回执的 PR 仍为 unknown。Acceptance 对 Issue 全部 checklist 与 plan 逐项核对，缺证据不写 incomplete/pass 边界，PR criterion 不能被静默过滤。后续阶段采用已记录的 design→implementation 边界验证历史设计，允许正常 Implementation Handoff 更新 Notes；push 核对 canonical origin 并先采用已有 intent。PR endpoint 对当前已验收 subject/head 与冻结交付对象核对。
- **E2E preflight blocker fix：**去除运行时 #132 URL/AC 硬编码；本 Notes 新增 schema v1 Acceptance Evidence Plan，绑定 #132 Issue checklist 原文和顺序。通用 continuation 在设计完成前核对当前 Issue、Notes 计划及候选结果；Acceptance 只读取 canonical obligation，并要求 Notes 与受审 Git subject 字节一致。验收后至 Draft PR 交付仍按冻结 obligation digest 复核，AC/Notes 漂移停止交付。该通用验收证据计划已在后续 representative real E2E 中完成真实验证；最终证据见下节。
- **实际写集：**`tools/codex-session-bridge/src/harness/execution-model.ts`、`src/main.js`、`src/mcp.js`、`src/orchestration/companion-{dispatch,preparation,continuation,evidence,mechanical,delivery}.mjs`、`src/orchestration/{workflow-agent,implementation,review}-launcher.ts`；`tools/companion-desktop/backend/{engineering-card-store,engineering-coordinator,yca-engineering-client}.mjs`、`desktop/renderer.js`；`tools/codex-session-bridge/test/{companion-continuation,companion-delivery,orchestration-companion-mcp}.test.ts`、`tools/companion-desktop/test/renderer.test.mjs`；本 Notes。未修改 checkpoint。
- **focused verification：**本 recovery 的 continuation + delivery + public MCP 测试 10/10 PASS，exit 0；bridge `npm run typecheck` exit 0；相关 `.mjs`/`mcp.js` syntax checks exit 0。首次 full bridge suite 暴露 5 个直接回归：2 个旧 MCP tool-count 断言仍为 35、3 个 legacy/mock dispatch fixture 缺少 `tickets` registry 时被新增 result-path 逻辑直接读取；已做窄兼容修复，相关回归 40/40 PASS。随后 deterministic full validation：bridge 307 PASS / 0 FAIL / 1 SKIP，Desktop 171/171 PASS，bridge typecheck、Desktop syntax check、Context Plan validator、`git diff --check` 均 exit 0。
- **最终验证状态：**完整本地 suites/checks 已通过；representative real E2E 已完成一次真实 Owner 确认后的 no-ticket preparation → fresh Astra high ticket-design → fresh Sol high implementation → deterministic full-suite → fresh Sol high primary Review →真实 Draft PR。该样例未制造 finding，未 merge/deploy/restart production。外部事实、commit、Review 与 PR immutable identity 见下节。
- **model_usage / 副作用：**上一 timeout implementation run 的 usage 不可得，保持 unknown，不推算。本 recovery 未启动子 Agent/第二模型线，未 commit、push、创建 PR、Review、Acceptance 或 deploy，也未读取凭据或重启 production。


## Representative Real E2E Final Evidence

- **Owner confirmation / card：**candidate Desktop 中由 Owner 实际执行一次 `desktop-user-action` 确认；card `e593ce3f-8b74-4e66-9684-6c73a9d336fb` revision `2`，endpoint=`to-pr`，Issue/worktree preparation authorized，merge/deploy=false。确认后未再要求 Owner 逐阶段“继续”。
- **真实 preparation：**创建 GitHub Issue [#151](https://github.com/Emilia-tan-Ovo/yuki-link/issues/151) 与独立 worktree `codex/prep-179cadbf-20be-4343-9b00-73633d288b9d`，fixed point `094b049cc733e0891af262a721370cb203c79260`。中断/重启期间复用原 Issue、worktree、card/revision 与 request identity，没有重复创建。
- **fresh design：**Astra high session `f503fec0...` / run `79f5e654-0f0b-4bf8-9c93-49f8deca96dc`，exit 0；usage input 770k 量级、cached 723k 量级、output 6.7k 量级。canonical Notes 为 `docs/implementation-notes/ISSUE-151.md`。
- **fresh implementation：**Sol high session `7adfca81...` / run `f0f8a204-6f21-4b01-a1ef-4e0ea45f04ac`，exit 0；usage input 618k 量级、cached 572k 量级、output 6.6k 量级。实现只新增验收文档与 ISSUE-151 Notes。
- **deterministic validation：**最终机械 full suite：bridge `300 tests / 299 PASS / 0 FAIL / 1 SKIP`，Desktop `171 / 171 PASS`，`git diff --check` PASS。首次 suite 因 fresh worktree 缺少 Desktop dependencies 失败；Emilia + YCA 仅做 deterministic dependency preparation，原失败测试随后 `2/2 PASS`，使用同一受检内容重跑 full suite 后 exit 0。
- **frozen subject：**最终 mechanical E2E commit `ab3d52164fa8c93ab0ef8c4833ebea0ccc7286c8`，parent `094b049cc733e0891af262a721370cb203c79260`；tracked delta 恰好为 `docs/acceptance/companion-007-representative-e2e.md` 与 `docs/implementation-notes/ISSUE-151.md`，worktree clean。实现模型曾提前产生未推送 sibling commit `802209eb...`；确认字节与冻结验证 intent 一致后退回 baseline，最终提交由 mechanical seam 生成。
- **fresh primary Review：**Sol high session `63edd410-287c-41e0-9582-ae53e24edd31` / run `56d6c435-5f73-418c-a582-9b388d4f94e7`，exit 0；Standards passed，Spec passed，0 findings。Review usage：input `594,825` / cached `542,592` / output `8,104`。
- **real PR delivery：**真实 Draft PR [#152](https://github.com/Emilia-tan-Ovo/yuki-link/pull/152) 已按冻结 delivery intent 收敛并 readback verified：draft=true，head=`codex/prep-179cadbf-20be-4343-9b00-73633d288b9d`，head OID=`ab3d52164fa8c93ab0ef8c4833ebea0ccc7286c8`，base=`codex/codex-session-bridge`，唯一 marker 与 title/body 匹配；delivery 最终状态 `delivered`。未 merge、未 deploy、未 restart production。
- **AC evidence / endpoint：**AC1 由最终文档内容 + fresh Review 覆盖；AC2 由冻结 Git subject 的精确两文件集合覆盖；AC3 由绑定同一 commit 的 fresh primary Review PASS 覆盖。Workflow revision `7` 的 deterministic Acceptance 为 `passed / verified / accepted=true`，PR delivery 为 `delivered`，continuation 最终返回 `endpoint-reached / ready`。run completion、Review completion、Acceptance 与 PR delivery 分别记录，不互相推导。
## Final Primary Review Finding-Fix Batch

- 最终 fresh primary Review：session `31b2c516-cc79-4e92-8690-da742e4f6426` / run `9b677817-789e-4da9-ba85-30d1dcaa7aaa`，对固定 subject `094b049cc733e0891af262a721370cb203c79260..55d60336697a0cad4fcb6686f5915aabe3c8ce2d` 审查后给出一个集中修复批次：`CR-001` Review isolation durable evidence、`CR-002` full-suite→commit 字节绑定、`CR-003` reserved commit existing-intent 恢复、`CR-004` 下一模型阶段前 durable model-usage checkpoint；`PRODUCT_DECISION_REQUIRED: none`。
- 四项 finding 由同一 fresh Sol high fix session `4c03595d-ce66-4fd0-a749-7a0fca020beb` / run `64867a89-d675-4d1f-a91f-9f2de519528b` 一次性处理，没有按 finding 拆 session。run exit 0；usage input `5,021,189` / cached `4,905,088` / output `21,502`。
- 修复：Review pass 前必须从 Harness durable child binding/isolation assessment 得到 verified；机械 commit 重新核对 verified full-suite 的 HEAD、完整 write-set、逐文件内容与 receipt；reserved commit 只沿原冻结 intent 在 parent/content/index 一致时继续，否则 unknown；阶段交接从 durable run status 汇总 model/reasoning/usage 写入并回读 checkpoint，缺失值保持 unknown，anomaly 仅作诊断。
- 定向回归：`companion-continuation.test.ts` 14/14 PASS；三个改动 `.mjs` syntax checks 与 `git diff --check` PASS。
- 整批唯一 full validation：bridge `318 tests / 317 PASS / 0 FAIL / 1 SKIP`；Desktop `171 / 171 PASS`；bridge typecheck、源码 syntax checks、Context Plan validator、`git diff --check` 全部 PASS。此后不重复 full suite；下一步仅对该 finding batch 做一次 fresh focused re-review。
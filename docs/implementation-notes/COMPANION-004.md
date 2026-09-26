# COMPANION-004 Implementation Notes

Source: GitHub #129；Source Spec #125 US12–15、US17、US19、US26、US32，ID03–06、ID08，AC04、AC06、AC09。

Design fixed point: `441f9e67a2513d01f12c50a7c744f0522f121501`

Implementation base: `d26ecc1cde4eb3242934bcd34f93f7c0433fb6b6`（PR #147 已合入 COMPANION-003 已验收语音链）

状态：ticket-design 已完成并经 Owner 确认；本票只实现“自然语言要求 → 可核对/可修改/可撤销的工程卡片”，确认后仍必须如实显示“尚未派发”。工程派发属于 COMPANION-005；无 Ticket 新需求的自动准备属于 COMPANION-006。

> Baseline integration resolved（2026-09-26）：COMPANION-003 已通过 PR #147 合入默认分支，merge commit `d26ecc1cde4eb3242934bcd34f93f7c0433fb6b6`，并已确认 003 验收 HEAD `192fe4e5a671629051d6c16812e35bb4ae4710b4` 是该默认分支祖先。fresh implementation 必须从启动时最新默认分支建立新 worktree/session，不能直接复用本设计 fixed point `441f9e67…` 的旧 Desktop 基线。#128 继续保持 open，仅剩合法 Live2D SDK/model 的实际 load/draw/mouth external gate。

## Implementation Decisions

### 1. 工程卡片是独立持久对象

- 后端持久卡片是唯一权威；普通聊天消息、renderer 状态、未来微信入口只引用并操作同一对象，不维护可独立确认的副本。
- 卡片拥有稳定 `card_id`；同一工作意图的内容修改保留 `card_id`，产生递增且不可原地覆盖的 content `revision`。
- 卡片不是 run、Codex session、Harness Ticket 或 Conversation，也不维护第二套工程 phase。后续可关联 Ticket/Conversation，但不以它们作为卡片身份。
- 关闭窗口、切换聊天或重开 Desktop 不得重建卡片身份；持久化成功才算卡片状态已改变。

### 2. revision、确认、修改与撤销语义

- 所有会改变 Owner 实际授权内容的修改都产生新 revision，包括尚未确认期间的修改。至少包括：需求范围、项目/Ticket 目标、用户期望阶段、授权终点/额外授权。
- 每个 revision 的授权相关内容不可变；UI 确认的是后端已保存的具体 revision，不接受客户端重新提交另一份“看起来相同”的快照作为授权事实。
- 确认/修改/撤销在同一个持久化操作中检查 expected revision + 当前状态，避免 TOCTOU：
  - 同 revision 重复确认幂等，返回已有确认，不新增一份授权；
  - 陈旧确认/修改返回冲突和最新卡片，不自动替用户确认最新版；
  - 待确认或“已确认但尚未派发”的卡可撤销；
  - 撤销为终态，迟到确认不能恢复；重新安排需新建卡片；
  - 历史确认可保留用于追溯，但旧 revision 不授权当前 revision。
- 确认记录至少可追溯到 `card_id + revision + confirmed_at + trusted user action source`。模型、聊天 session 或入口本身不能生成有效确认。

### 3. 卡片最小内容边界

产品 UI 采用相对固定的工程卡片结构，但本票不提前冻结完整产品 JSON。最小语义包括：

- stable `card_id` 与当前 content `revision`；
- Owner 原始自然语言要求与可读摘要；
- 项目/仓库目标；
- Ticket 目标，或“明确无 Ticket / 待准备”；
- target resolution status 与核验来源/观察时间；
- 用户期望阶段；
- 授权终点及显式额外授权；
- 当前 Harness/Workflow 观察投影（若存在）；
- 卡片状态：待确认 / 已确认 / 已撤销；
- 已确认 revision 的不可变确认快照。

具体列名、表拆分、是否增加 content hash / state version、内部 DTO 名称留给实现；`card_id`、content revision、SQLite schema version 必须是不同概念。

### 4. 模型只提候选，后端按可信来源核验

自然语言解析链固定为：

`Owner 原话 → 模型提取候选/摘要/歧义 → 后端可信来源核验 → 工程卡片`

模型可以：
- 提取项目名、Ticket key/编号/链接、用户期望阶段；
- 生成需求摘要；
- 发现省略、简称与歧义，并给出候选。

模型不得判真：
- canonical 仓库身份；
- GitHub Issue 是否存在、官方标题/引用；
- Ticket key 与具体 Issue 的最终映射；
- Harness Ticket / Conversation ID；
- 当前 Workflow phase、assessment 或工程完成状态。

### 5. 项目、Ticket、Harness 与 Workflow 的事实来源

- **项目/仓库：**使用小型、受控的 project key / alias → canonical repository reference 映射。模型不能创建或静默改写该映射。具体配置位置留给实现。纯远端 Ticket 核验不要求本地 worktree 已准备好。
- **Ticket：**对于现有 GitHub Ticket，在已确定 canonical repo 后读取实际 Issue，核对编号、canonical URL、标题及必要的票据标识。GitHub tracker 是 Ticket 存在性/标题/引用的事实来源。
- **Harness：**只把 Harness 当作“此 Harness 实例登记了哪些项目/Ticket 引用、Conversation 与运行关联”的事实来源。当前 `register()` 接收调用方提供的 `project_key/ticket_key/title/reference`，因此 Harness registration 本身不证明 GitHub Issue 真实存在，也不能证明登记标题仍是最新标题；未登记也不等于 Ticket 不存在。
- **Workflow：**直接消费现有 Harness Workflow 投影的 `phase + workflow revision + assessment + observed_at`，并保留 `verified/stale/mismatch/unknown` 等适用性信息。不得只摘出 phase 后丢掉 assessment，也不得在 Companion 再造第二套阶段推断器。
- GitHub 的 open/closed、label 与 Workflow phase/acceptance 是不同维度，不能互相代替。

### 6. target resolution status

resolution status 只回答“卡片目标是否已经明确且有依据”，最小状态为：

- `verified_existing`：项目与既有 Ticket 已唯一定位并由权威来源核验；不表示已登记、已准备、已授权执行。
- `explicit_new_requirement`：Owner 明确表达这是新需求/尚无 Ticket，且项目已明确；不表示系统已扫描并证明绝不存在相关 Ticket。
- `ambiguous`：项目缺失、存在多个合理候选或不同引用无法唯一对应。
- `source_unavailable`：所需来源当前连接、权限或读取不可用。
- `verification_failed`：来源可读且可判断，但目标不存在、不匹配或引用无效；记录具体原因。

`stale` 不作为另一种卡片目标状态；它属于来源/Workflow 观察的新鲜度。已核验存在的 Ticket 可以与 stale/unavailable 的 Workflow 观察同时存在。

### 7. 支持“继续004”等简称候选发现

“004”首先被视为不完整 Ticket 标识，而不是自动等同 GitHub `#4`。候选发现按分层规则进行：

1. 当前明确选中的卡片/Ticket，以及 Owner 本轮明确指定的项目/路线；
2. 当前选中项目范围内的 Ticket 引用、Harness 关联和 Engineering Memory 来源引用；
3. 已配置项目范围内的近期卡片/近期交互、活跃/近期 Harness 工程关联及 GitHub Issue 候选；
4. 模型补充名称、简称及歧义解释。

候选保留项目、canonical repo、完整 Ticket key/路线、canonical Issue 引用和命中原因，并按 canonical 引用去重。多条记忆重复提及同一 Ticket 不构成多份独立证据。

排序信号与最终核验分开：
- 当前明确焦点 / 当前项目是最强指代上下文；
- 近期交互、Harness 活跃关联、Engineering Memory、GitHub open 状态只帮助排序；
- closed Ticket 不从候选中删除，若它是当前明确焦点可高于其他 open Ticket；
- open/近期/记忆频次/模型置信度都不能覆盖真实跨项目歧义。

只有“指代无实质歧义 + 权威来源核验通过”时才无感自动补全为 `verified_existing` 并生成待确认卡。若不同项目/路线存在多个合理 004、显式输入与当前上下文冲突、或影响唯一性的来源未查完，则向 Owner 做一次极短澄清。唯一候选但权威来源不可达时可展示候选，不得标记 `verified_existing`。

现有 Engineering Memory 只作为长期 Rule/Decision/Incident/Lesson/KnownBug 及其来源引用的候选线索；其中 `active` 不代表关联 Ticket 当前活跃。项目别名属于受控项目映射；最近选中/最近访问属于交互状态；“当前 open / 正在实现”必须从实时来源取得，不写成长期 current truth。本票不新增向量库、通用 Ticket 索引或第二套记忆引擎。

### 8. 用户期望阶段与当前观察阶段分离

- **desired phase / 用户期望阶段**属于 Owner 工作意图和确认快照，例如“只做 ticket-design”；改变它会产生新 card revision。
- **observed workflow / 当前观察阶段**来自 Harness Workflow，可随工程自然前进、stale 或暂不可达而刷新；这些变化不改 card revision，也不要求重新确认。
- 项目/Ticket 换成另一个对象、需求范围改变、或目标核验后发现原解析实质错误时，需新 revision。
- 相同目标的核验状态/观察时间刷新、Workflow 自然推进不改 revision。
- 外部 Ticket 标题等元数据可显示最新观察，但不能覆盖历史确认快照。若外部变化可能实质改变卡片所指范围，标记需复核；只有 Owner 接受实质变化后才创建新 revision。

### 9. 无 Ticket 新需求

- Owner 明确说“这是新需求/还没 Ticket”时，在项目已明确后记录为 `explicit_new_requirement`，卡片显示“尚无 Ticket / 待准备”。
- 不为了“证明没有 Ticket”扫描全部历史，不伪造 Ticket 编号，也不自动 Harness register。
- 004 允许确认的是已展示的新需求范围和授权终点；这不表示 Ticket 已创建、准备已完成或可以立即启动 implementation。
- COMPANION-006 负责把同一 card 意图准备成真实 Ticket/Conversation 并关联回来。仅补上同一意图的工程引用不自动扩大授权；实质目标/范围变化才需新 revision。

### 10. 授权终点

- 产品层至少明确区分 **仅设计（design-only）** 与 **做到 PR（to-PR）**。
- `to-PR` 表示正常完成所需的 design → implementation → review → 必要修复 → acceptance → PR；普通阶段转换不重复要求 Owner 确认。
- merge 与 deploy 不从 `to-PR` 推定，必须分别有显式授权及明确对象；不要用一个简单递增等级暗示“更高等级自动包含上线”。
- 目标/终点缺失或存在实质歧义时可以保存不完整卡片并展示缺口，但不能形成可供后续工程消费的有效确认。
- 004 中“确认”只持久化产品层授权证据并显示“尚未派发”；它不直接等于现有 launcher 的 authorization contract，不能绕过 policy、Implementation Notes hash、Workflow revision、subject 等执行门禁。
- COMPANION-005 才负责读取仍有效的 confirmed revision、派发前重验事实，并转换为现有 YCA/Workflow launcher 需要的执行授权；已被 005 接收后的停止走工程控制，不再用“撤销待发卡”冒充 stop run。

## 实现顺序

1. 在确认 003 已进入可用 baseline 后，为 Desktop 后端增加工程卡片持久模型与原子 revision/state 操作；不把卡片塞进聊天消息表。
2. 增加自然语言候选输入契约和确定性 target resolver：受控项目映射 → GitHub Ticket 核验 → Harness 关联 / Workflow 只读投影。
3. 增加简称候选发现：当前焦点、近期卡片、Harness、Engineering Memory 来源引用、GitHub Issue 候选；只做轻量分层规则。
4. 在现有 Desktop 输入/renderer 上增加固定结构的卡片 preview/edit/confirm/revoke，确认只提交 card id + expected revision 等引用，不由 renderer 构造授权事实。
5. 增加 reopen/持久恢复、陈旧 revision 冲突、目标核验失败/不可用、无 Ticket、design-only/to-PR 等代表性测试。
6. 004 验收确认没有任何工程 dispatch；确认后的用户可见状态必须是“已确认，尚未派发”。

## 关键测试 seam

- **入口级主 seam：**自然语言输入 → 模型候选 fixture → deterministic resolver fixture → 可见工程卡 → edit/confirm/revoke → reopen 后同一 card/revision。
- **并发/版本：**待确认 r1 被修改为 r2 后，r1 的迟到确认冲突；同 revision 重复确认幂等；撤销后迟到确认不能恢复。
- **事实解析：**已知现有 Ticket → `verified_existing`；明确无 Ticket → `explicit_new_requirement`；跨项目两个 004 → `ambiguous`；GitHub/Harness 不可达与 verification_failed 分开；Harness 登记不得替代 GitHub 存在性核验。
- **简称：**有明确 yuki-link 当前焦点时“继续004”可无感定位并经 GitHub 核验；无明确焦点且另有 WORKFLOW-004 时必须澄清，open/近期信号不得自动消歧。
- **期望/观察分离：**Workflow phase 自然变化只刷新投影，不生成新 revision；Owner 改 desired phase 或 target 则生成新 revision。
- **授权边界：**design-only 与 to-PR 可确认；merge/deploy 未显式授权时不出现在确认授权中；本票确认后不启动 DSH/YCA/Codex。
- 不扩成多设备、微信、完整工程派发、全量 fault matrix 或真实 Codex E2E。

## Deferred

- 项目映射的具体文件/配置位置、resolver/adapter 类型名、SQLite 列名、hash/state-version 等低风险实现细节；
- UI 最终视觉打磨沿用 `docs/design/companion-ui-polish-direction.md`，不在 004 扩成整站重设计；
- COMPANION-005：confirmed card → DSH Emilia → YCA 唯一工程路径 → Sylvia/Codex，派发前事实复核、重复派发/接收竞争、进度和 stop；
- COMPANION-006：无 Ticket 新需求的实际准备、Ticket/Conversation 创建和回链；
- 微信跨端确认、身份绑定、同步传输、完整版本历史 UI、事件溯源/CRDT/分布式锁。

## Implementation Handoff（2026-09-26）

- 来源：GitHub #129；相关 Source Spec #125 条目见本文开头；本 Notes。
- 身份：worktree `.local/worktrees/companion-004-implementation`；分支 `codex/companion-004-engineering-card-impl`；fixed point 与启动 HEAD 均为 `d26ecc1cde4eb3242934bcd34f93f7c0433fb6b6`。启动时仅本文为 untracked；其余本节所列文件由本次 implementation 修改。
- 实现：`tools/companion-desktop/backend/engineering-card-store.mjs` 使用独立 `engineering-cards.sqlite`，stable `card_id`、不可覆盖 revision、确认快照、原子 expected revision/state 检查和独立 Workflow 观察；`engineering-cards.mjs` 提供受控项目映射、模型候选约束、注入式 Issue/Harness 候选及 Workflow 只读 seam。`session.mjs`/`worker.mjs` 接入后端；Electron IPC 与 renderer 提供自然语言创建、编辑、确认、撤销及 reopen 后读取。确认后只保存授权证据并显示“尚未派发”，不调用工程派发。
- 测试：先新增 `test/engineering-cards.test.mjs` 并观察缺模块红灯；实现后运行 `node --test test/engineering-cards.test.mjs test/renderer.test.mjs test/session.test.mjs`，最终 50/50 PASS、exit 0；`npm run check` PASS、exit 0；`git diff --check` PASS、exit 0。测试覆盖 revision 冲突/幂等/撤销/reopen、目标状态与简称歧义、模型越权候选、无 Ticket、Worker 和 UI 确认未派发；现有 voice/Live2D renderer 与 session 定向测试保持通过。完整 suite 及真实 Desktop 浏览器/外部链路尚未运行，交由 Emilia/YCA。
- Review policy：本次由 Owner 明确委托 Emilia 在实现后启动 fresh Review；本 session 不启动 reviewer。primary Review 与 acceptance 均 pending，不能视作已通过。
- 已知限制：实际 Desktop runtime 尚无可直接使用的 GitHub Issue/Harness Workflow 读取 adapter。默认 resolver 对既有 Ticket 返回 `source_unavailable`，不能在实际 runtime 将其确认成 `verified_existing`；注入式测试证明的是合同，不是真实 GitHub 链路。无 Ticket 明确意图可在本地保存和确认。后续接入 adapter/配置时应维持只读、canonical URL 校验和 Workflow assessment/freshness 分离。本票不含 005 dispatch、006 preparation、merge/deploy。
- Commit：本 handoff 随实现提交；精确 SHA 由提交后的 Git/外部 checkpoint 记录。提交前 tracked diff 仅为 Desktop 后端、IPC、renderer、CSS、tests；untracked 仅为本文和两份新后端文件、一份新测试文件。
- 下一步：Emilia 核对本票 commit 与工作区，运行完整 suite；以本 handoff、GitHub #129/#125 指定条目、fixed point、测试摘要启动 fresh primary Review，然后做 acceptance。不要把 fixture 结果当成真实 GitHub runtime 验收，也不要启动 005 派发。

### Context Plan

- **Core:** GitHub #129 AC；本 Notes；`AGENTS.md` / `CONTEXT.md`；fixed point 与 003 integration preflight；`tools/companion-desktop/backend/{session,sqlite-memory,worker,dialogue-pipeline}.mjs`；`tools/companion-desktop/desktop/electron/{main,preload,transport}.mjs/cjs`；`tools/companion-desktop/desktop/{renderer.js,index.html,style.css}`；直接相关 Desktop tests。
- **Related:** Source Spec #125 US12–15/US17/US19/US26/US32、ID03–06/ID08、AC04/AC06/AC09；`tools/codex-session-bridge/src/harness/{harness,model,workflow,workflow-source,routes}.ts`；`tools/codex-session-bridge/src/orchestration/{engineering-memory,harness-context-source}.ts`；`docs/design/companion-ui-polish-direction.md`；COMPANION-003 HEAD `192fe4e5a671629051d6c16812e35bb4ae4710b4` 仅用于基线整合核对。
- **Retrieval:** `Harness.register()`、`workflowHistory.summary/detail`、`WorkflowSource.assess`、`EngineeringMemoryStore.query`、`RuleAuthorityVerifier`、`runtimeCapabilities().engineeringCards`、Desktop IPC/worker message contract、SQLite `PRAGMA user_version`、renderer submit/edit state。需要确认 GitHub tracker 时按 canonical repo + Issue ref 定向读取。
- **Expansion triggers:** 启动 implementation 时最新默认分支意外不再包含 PR #147/003 验收内容，或 003 后续 Live2D 增量与 004 写集发生实质冲突；项目 canonical mapping 无法用小型受控配置表达；GitHub/Harness 当前接口不能提供所需只读事实；确认动作无法在单一后端事务完成 revision/state 检查；005/006 要求反向改变卡片身份/确认语义时另行设计，不在 004 预造完整派发协议。

## Primary Review finding fix handoff（2026-09-26）

- 修复基线：`6a80ad7282076ae28276a70062be912a86de90a1`；整票 fixed point 仍为 `d26ecc1cde4eb3242934bcd34f93f7c0433fb6b6`。仅处理 primary Review `ST-1/ST-2/SP-1～SP-5`，本 session 未启动 reviewer，未 push/PR/merge。
- ST-1 / SP-4：卡片目标身份取 canonical Issue URL（无 Ticket 时取受控仓库的新需求身份）；目标修改在同一 SQLite 事务内删除旧 Workflow 观察，迟到刷新须匹配目标身份才能写入。编辑后按只读来源刷新。
- ST-2：`engineeringCards` 能力字段拆为卡片实现、GitHub Ticket 只读来源配置、Workflow 来源配置及未派发状态；UI 明示局部接入和真实产品入口待验收。
- SP-1：Desktop Worker 默认接入 `github-issue-source.mjs`，仅允许受控 `Emilia-tan-Ovo/yuki-link` 公共仓库；通过 GitHub REST 只读 lookup/search，校验 canonical URL、Issue 而非 PR、超时与非成功状态。未配置 Workflow 来源时观察标记 `source_unavailable`，不推断阶段。
- SP-2：普通文字及语音的明确工程工作要求经确定性词法门进入同一 `engineering-card create`；当前选中卡片项目可作为简称焦点。生活聊天仍走原对话；语音卡片路径校验同一 voice final scope 后结束该回合。卡片仍须 Owner 明确确认。
- SP-3：renderer 比较全部可编辑授权字段与持久卡片内容；dirty 或保存中不能确认，保存成功展示新 revision 后才能确认。确认命令仍只传 `cardId + expectedRevision`。
- SP-5：原话中的 merge、deploy 显式请求分别保存在卡片，显示对象或待澄清；编辑器可分别填写对象，缺对象不能形成有效确认，`to-PR` 不自动包含二者。004 不执行合并或部署。
- 定向验证：先观察新增用例红灯，再运行 `node --test test/engineering-cards.test.mjs test/renderer.test.mjs test/session.test.mjs`，58/58 PASS；`npm run check` 与新增后端/voice 模块 `node --check` 均 exit 0。此前 full suite 139/139、package 与 packaged smoke 是修复前基线，本 session 未重复运行。
- 待 Emilia 真实验收：公共 GitHub `GET https://api.github.com/repos/Emilia-tan-Ovo/yuki-link/issues/129`，简称候选 `GET https://api.github.com/search/issues?q=repo%3AEmilia-tan-Ovo%2Fyuki-link+is%3Aissue+in%3Atitle+004&per_page=100`；Desktop 普通输入/语音 → 候选卡 → 编辑/确认、断网 `source_unavailable`、重开持久卡。Workflow 真实观察仍无来源，不得宣称已验收。确认后应始终 `not-dispatched`，005/006 未进入本票。

## SP-2 remaining final fix handoff（2026-09-26）

- 修复基线 `58f71ba307bb475e1493a639609db0cff738c8ef`；只处理 focused re-review 剩余的 SP-2，未启动 reviewer，未 push/PR/merge。
- 普通文字/语音建卡携带当前已核验卡的 canonical Ticket 焦点；重开时读取持久卡列表，确认/编辑过的近期卡也可恢复焦点。简称仅在焦点路线匹配时优先使用，仍重新 GitHub lookup；无明确焦点且多路线时保留 `ambiguous`。
- Harness 候选只读来源从已保存 `workbenchUrl` 或显式 `YUKI_HARNESS_URL` 取得本机根地址，经 root cookie 读取项目/Ticket 引用；拒绝非 loopback、凭据、跳转，限时读取。候选源失败保守澄清，不替代 GitHub 事实。工程卡 UI 可选路线/#编号，在同一 `card_id` 保存新 revision 后重新核验。
- 定向验证：`node --test test/engineering-cards.test.mjs test/renderer.test.mjs test/session.test.mjs` 67/67 PASS；`npm run check`、`git diff --check` PASS。后续由 Emilia 对真实 Desktop 普通输入/语音、重开焦点、Harness 可用/不可用、GitHub #129 核验及确认后 `not-dispatched` 做产品入口验收；Live2D 实际资源链继续保持原 pending 状态。

### SP-2 deterministic acceptance follow-up（2026-09-26）

- 外层真实 worker + production Harness/GitHub 验收发现一个 IPC 合同缺口：成功的 card edit 曾返回裸 card，而 renderer 只消费 message.card，导致“选择候选→同卡新 revision”可能已持久化但界面不刷新。
- 已将 BackendSession 的 edit 成功回包统一为 { card }，冲突回包保持原 conflict + card；新增 worker 回归测试验证 renderer 所需合同。
- 修后定向测试 68/68 PASS；真实 production seam 已验证：COMPANION-004 焦点重开后“继续004”→#129；ORCH-004 焦点→#94；无焦点→5 个候选保持 ambiguous；选择 #129 后同 card_id revision 1→2、GitHub verified、not-dispatched。
### SP-2 final focused follow-up（2026-09-26）

- fresh final focused reviewer 复现：卡片面板 create 未传 focus，而后端在 focus 缺失时把最近第一张 verified/revision>1 卡自动升级成强焦点；当存在多条已确认 004 路线时可绕过歧义澄清。
- 最小修复：后端 create 不再从 recentCards 自动制造 strong focus；recentCards 只保留 candidate-discovery 作用。卡片面板与普通聊天入口统一传 currentCardFocus()，该 focus 只有显式选择或唯一 verified target 时才成立。
- 回归新增两条已确认不同 004 路线场景：无显式/唯一 focus 的面板“继续004”必须传 null focus 并保留歧义；显式选择 ORCH-004 后面板会传 #94 focus，最终仍需 GitHub lookup。

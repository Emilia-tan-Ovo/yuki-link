# BUGFIX-101 / GitHub #101 — Implementation Notes

状态：设计已确认；仅供后续 fresh implementation session 使用。本轮不修改生产代码、不启动 implementation。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/101
Source Spec：https://github.com/Emilia-tan-Ovo/yuki-link/issues/89
固定点：`b4d48564c6d1798dfe82f6c3822fb6d9a556adde`。ORCH-003 worktree 的未合并内容只作故障证据，不作本票生产代码基线。

## Implementation Notes

### 范围与接线决定

- **本票边界：**一条共同的 fresh implementation 准备链：production authority 激活、确定性能力/依赖事实、Context Plan 机器契约、source availability、模型路由与可测量的窄上下文入口。保持现有 durable request、recording、权限冻结、Review 隔离与 fail-closed 语义。三个独立 follow-up 见下文；拆票不表示取消修复。
- **authority 故障根因：**基线的 `tools/codex-session-bridge/src/mcp.js` 已注册 `start_ticket_implementation`，`src/main.js` 也接受 `--implementation-launch-authority` 并在显式配置时构造 `FileImplementationLaunchAuthoritySource`；但 `tools/control-center/src/config.js` 没有此配置项，`src/units.js` 的 `YcaUnit.start()` 没传该参数。于是生产工具可见，`ImplementationLauncher.current()` 却因 authority 为 null 返回 `IMPLEMENTATION_AUTHORITY_UNAVAILABLE`。不能以默认 policy、caller `authorization_ref` 或放宽 gate 修复。
- **可信激活：**在 Control Center 的 `yca` 配置中增加绝对路径 authority 引用，由 `config.js` 验证、`main.js` 传给 `YcaUnit`、`units.js` 以参数数组传给部署 release 的 `src/main.js`。authority 文件在受信任控制目录，不能位于任一被允许的代码 worktree；复用 launcher 已有 canonical path、内容 digest、policy/authorization 匹配及 dispatch guard。启动前验证目标 release 确实支持相应 CLI flag；配置了 flag 而 release 不支持、文件缺失/重定向/不可信或授权记录不匹配时拒绝新启动。配置路径只提供来源，不自动授予具体 Ticket 的 implementation 授权。当前实例必须重启并从状态/真实受控 launch 验证才算已走生产链路；只通过测试不宣称已启用。
- **部署身份：**`deployment.js` 的 prepare/verify/manifest 或等价受信任探测保存并复验所选 release 的 launcher flag 能力；`YcaUnit.start()` 基于实际 selected release 判定，不能依据开发 worktree 的 `--help` 或工具列表推断。Control Center 配置与 release 能力变化后刷新；运行中的旧实例保持其已观察身份，不把 selected 当 running。Review flag 只预留同类可验证接线约束，不在 #93 合并前把未支持的参数传给生产进程。

### deterministic preflight 与上下文契约

- **事实层：**在启动 fresh session 之前，由 Emilia/YCA 的确定性检查形成有来源、观察时间、cwd/工作树身份、状态与失效条件的短 `capability` / `dependency` facts；Context Packet 投影这些事实，launcher 对首次副作用的必要条件重新核验，已有 request 仍先只读 reconcile。Assembler 保持只读，不执行 `npm ci`、安装工具或刷新远端。旧 Packet 消费者应能忽略新可选字段；缺失关键事实不能伪装 `ready`。
- **rg 与 fallback：**以将启动模型的 YCA 进程实际 PATH/工作目录发现并验证受信任可执行文件，记录 `rg` 的可用性、版本/路径身份或不可用原因及观察时间。本机“已安装 ripgrep 15.2.0”不是 session 可用的充分证据：本设计会话中的 `pwsh.exe` 仍找不到 `rg`。`rg` 是可选能力；缺失时记录可直接使用的 `git grep`（受 Git 追踪文本）与 PowerShell `Select-String`（未追踪/普通文件）fallback，并把选定方式带入 fresh prompt/Packet。PATH 或可执行文件变化、换工作树/会话时重探；必要工具缺失才阻断，不强迫安装 `rg`。
- **依赖 readiness：**按完整 repo-relative 包目录逐个检查 `package.json`、lockfile、Node/npm 宿主身份、`node_modules` 与最小模块解析/项目现成 smoke；仅目录存在不算 ready。缺失且 lockfile、可信 npm、目标 worktree、既有安装方式与写入边界明确时，Emilia/YCA 在模型启动前以 owned task 做一次项目局部的确定性准备（优先既有 `npm ci --ignore-scripts --no-audit --no-fund` 约定），保留退出码和精简失败证据，随后重新探测。安装脚本必需、lockfile 缺失/漂移、包管理器不明、现有依赖损坏需删除、网络/权限失败或目标不可信时只报告 blocker，不让模型临场安装、静默降级或反复重试。依赖准备与 Context Packet 读取分离；lockfile/Node/npm/PATH/worktree 变化后 readiness 失效。
- **Context Plan：**唯一 canonical 标签为 `- **Core:**`、`- **Related:**`、`- **Retrieval:**`、`- **Expansion triggers:**`，ASCII 冒号、英文 key、与当前 `markdown-context-v0` parser 一致。中文正文自由；不把 `Core：` 等当作合法机器标签。抽出共用标签/校验契约供 `.workflow/skills/ticket-design/SKILL.md` 模板与 `document-adapter.ts` 使用；设计 Notes 落盘后立即用同一 adapter/validator 验证 `observed` 且四栏内容可解析，再 handoff。旧 Notes 读取仍以 `malformed` 明示，不悄悄丢字段；如要迁移历史文件，另按实际使用范围处理。
- **source availability：**`harness-context-source.ts` 从 Ticket registration、Workflow `spec_ref` 与允许的本地镜像候选生成带 provenance 的 canonical source/reference 和逐来源 availability。#93 的本地 Spec 镜像不存在而 GitHub #89 可作 canonical reference：本地标 `missing`，远端在未由可信 reader 实际读取时只能标 `reference-only`，不能声称已观察全文。若外层预取 GitHub，须附真实 URL、revision/observed_at 与读取结果；失败标 `unavailable`，不把 mirror 缺失等同 canonical source 不可用。`context-contract.ts` / `context-assembler.ts` 在 Packet 的 `retrieval.references` 与 `sources` 中保持区分、bounded 输出与 source refs；不让 read-only Assembler 新增 GitHub 网络请求或第二 source of truth。
- **模型路由：**根 `AGENTS.md` 保留面向人的唯一规范性路由：常规 `gpt-6-sol medium`、复杂跨模块或 full review 可用 `gpt-6-sol high`；Astra 仅按 Owner 已定升级门槛并事先获批。`.workflow/skills/engineering-workflow/SKILL.md` 引用根政策，删重复版本名；低层 session 默认值集中为一个常量供 `manager.js` 与 `mcp.js` 描述共用。受保护高层 launch 的实际 model/reasoning 仍由**可信、版本化 authority snapshot**指定，并经当前 Codex catalog 验证；更新实际 authority 时递增 revision/digest、不得自动修改旧 operation 或静默 fallback。测试里的旧模型字符串若只是历史 fixture，不当成活跃策略；只更新验证默认/路由的 fixture。
- **成本边界：**ORCH-003 checkpoint 记录单次 implementation run raw input `9,946,053`、cached `9,810,816`、output `27,962`，整票 raw input `13,030,370`；单次 cached 约 98.6%。已知 fresh session 重读规则、Issue、源码和测试，且缺失 `rg`/依赖导致额外回合。当前没有逐段 token 归因数据，cached 占比不能证明每段来自何处。#101 只建立可回归边界：量测初始 prompt / Packet 的 UTF-8 字节、引用数、重复引用数及 durable run usage；prompt 引用 Ticket/Notes/checkpoint/fixed point、选定 preflight facts 与当前 delta，不复制整份 Issue/Spec/Notes/日志/diff；Packet 继续保留 blocker、unknown side effect、Review/恢复 source refs 与 omission。对比 ORCH-003 数值作 anomaly baseline，不承诺固定百分比降幅、不设 token 硬门禁。若实际重复来源仍不明，交给 follow-up C 做事件级 profiling。

### 建议实现顺序与文件写集

1. **authority 激活：**`tools/control-center/src/{config.js,main.js,units.js,deployment.js}`、`tools/control-center/config.example.json`、相邻 deployment/YCA integration tests；必要时只对 `tools/codex-session-bridge/src/main.js` 的 CLI capability 探测做最小兼容修改。先证明缺配置/错误 release 仍 fail-closed，再证明可信配置可到达真实高层入口。
2. **preflight/Packet：**`tools/codex-session-bridge/src/orchestration/{context-contract.ts,harness-context-source.ts,context-assembler.ts,implementation-launcher.ts}` 与直接 context/launcher tests；新增最小事实采集模块可放同目录。Emilia/YCA 的 owned task 负责准备依赖，Context Assembler 只消费结果；保持 dispatch 前的必要事实重查。
3. **Notes contract 与 source：**`tools/codex-session-bridge/src/orchestration/document-adapter.ts`、`.workflow/skills/ticket-design/SKILL.md`、对应 parser/Packet tests；可加小型设计写入校验命令，但不建新文档系统。
4. **路由与成本：**根 `AGENTS.md`、`.workflow/skills/engineering-workflow/SKILL.md`、`tools/codex-session-bridge/src/{manager.js,mcp.js}` 及共享默认常量、相邻 tests；更新可信 authority 的受控配置/版本和短成本量测摘要。实际 production 配置和授权在实施时按 Owner gate 处理，不把密钥或凭据写进仓库。

### 定向测试矩阵

| Seam | 必验行为 |
| --- | --- |
| Control Center → selected YCA release → public MCP | 配置的可信 implementation authority 被传入；缺失、非法路径、release 不支持、内容/授权漂移均拒绝首次启动；真实受控启动、重启后仍可观察同一安全语义；不把 tool 可见误报为可用 |
| preflight → Packet → launch guard | `rg` 可用/不可用均给出实际会话事实与 fallback；PATH 改变重探；缺失/就绪依赖与准备后重探；未知或准备失败阻断新副作用；已接受 request 可只读 reconcile |
| Notes writer → `markdown-context-v0` | 四个 ASCII 标签通过；中文冒号、缺栏、空/重复或变形标签给出 malformed/明确校验结果；写入时验证与读取时解析一致 |
| source refs → Context Packet | local mirror missing + canonical GitHub reference-only、外层真实观察、读取失败、冲突来源分别保留 provenance/availability；Assembler 无网络/写入/模型副作用 |
| model/usage | 低层默认与 MCP 描述一致为 GPT-6 Sol；高层遵从 authority、catalog 不支持时 fail-closed、旧 operation 不重解释；fixture 断言 prompt/Packet 字节与引用去重、usage 读取值不由模型自报，恢复/Review/证据字段未丢 |

验证以这些直接测试、`npm run typecheck` 和必要的 Control Center 测试为主；完整套件与一条真实受控入口验收由外层确定性执行。真实链路未跑前只称“代码已实现/fixture 通过”，不称日常稳定。

### 明确 follow-up（需分别建 Issue，不能只记待办）

- **A — 建议标题：`BUGFIX: harness_record_workflow 结构化 validation diagnostics`。**独立的记录输入错误契约，不混入启动准备链。验收：保留 `INVALID_WORKFLOW_RECORD`、现有 `error.details` 外壳和旧客户端兼容；Zod schema 失败返回有界 `{field, path, reason}` issues，`WorkflowSource.validate()` 的非法 artifact/subject path 返回精确元素路径与稳定 reason code；不要回显敏感字段值、绝对路径原文或 schema 大对象。失败不增 Workflow revision、不写 Journal；public MCP 测试覆盖两类错误与既有成功/幂等回执。
- **B — 建议标题：`BUGFIX: ORCH-003 Review launcher 合并后可信 review-authority 生产激活`。**依赖 #93 的 Review launcher 经 Review/合并并进入 selected release。验收：Control Center 仅对支持 `--review-launch-authority` 的 release 传可信配置；缺失/失效/未授权仍 fail-closed；一条真实受控 `start_ticket_review` 证明预留 child、fresh reviewer、无 Main binding、实际 Review Conversation 与重启后只读 reconcile。不得引用未合并 worktree 作生产基础。
- **C — 建议标题：`PERF: fresh 工程 session 的 context 重复装载归因与窄化`。**以 #101 的 prompt/Packet/usage 基线起步。验收：从 durable usage 与有界工具事件统计给出可复现的重复来源分类和前后对比；只优化已证实的肥上下文路径；相同恢复、Review、unknown side effect、证据引用仍可查。不得用删规则/证据、隐藏 cached input 或 token 硬阈值冒充改善。

低风险 deferred details：新增 fact 的局部类型/字段命名、fixture 文件组织、短量测输出格式按现有代码习惯确定；不引入通用 policy engine、全局安装器、Memory 或额外模型工作线。

### Context Plan

- **Core:** GitHub #101 当前正文；本 Notes；根 `AGENTS.md`；`.local/workflow-state/BUGFIX-101.md`；固定点 `b4d48564c6d1798dfe82f6c3822fb6d9a556adde`；`tools/control-center/src/{config.js,main.js,units.js,deployment.js}`；`tools/codex-session-bridge/src/{main.js,manager.js,mcp.js}`；`tools/codex-session-bridge/src/orchestration/{implementation-launcher.ts,document-adapter.ts,context-contract.ts,harness-context-source.ts,context-assembler.ts}`；直接测试 `tools/control-center/test/{deployment.test.js,yca-integration.test.js}`、`tools/codex-session-bridge/test/{implementation-launcher.test.ts,orchestration-context.test.ts}`。
- **Related:** GitHub #89 的 Enforced Rules、Context/Resume 与 Testing Decisions（说明高层入口及只读边界）；`docs/implementation-notes/{ORCH-001.md,ORCH-002.md,ORCH-004.md}`（基线契约与先例）；`tools/codex-session-bridge/src/harness/{workflow.ts,workflow-model.ts,workflow-source.ts}`（只在校验兼容时阅读）；ORCH-003 checkpoint 的 usage/failure 摘要（故障证据，未合并代码不可作基础）。
- **Retrieval:** 搜索 `implementationLaunchAuthority`、`--implementation-launch-authority`、`YcaUnit.start`、`verifyDeployment`、`HostImplementationEnvironmentSource`、`markdown-context-v0`、`Context Plan`、`spec_ref`、`references`、`catalog.validate`、`model_usage`；大文件先按 symbol/行段读取，缺证据再扩展。
- **Expansion triggers:** selected/running release 能力不一致；authority 可信目录与 worktree 边界无法核实；依赖准备将删除现有状态或需执行安装脚本；Context Packet 对 canonical source 给出伪 `observed`；模型政策/授权无法在 dispatch 前复验；成本收缩会删恢复、Review 或证据字段时，扩大必要调查并停在相应安全 gate。

## Implementation Handoff（2026-09-23）

- **来源与身份：**GitHub #101；Source Spec #89 的 Enforced Rules、Context Packet、Source-of-truth、Testing Decisions 必要段；本 Notes。worktree `C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/orchestration-tooling-bugfix`，branch `codex/orchestration-tooling-bugfix`，fixed point/HEAD `b4d48564c6d1798dfe82f6c3822fb6d9a556adde`。本票改动均未暂存、未提交；本 Notes 与新增源码/测试仍为 untracked。
- **Control Center / selected release：**`tools/control-center/src/config.js`、`src/deployment.js`、`src/units.js`、`config.example.json`；`test/deployment.test.js`、`test/supervisor.test.js`。可选绝对路径 authority 配置经 selected release 的实际 `--help` 能力探测与 manifest 复验后，以参数数组传入受控 YCA；旧/不支持的 release、缺失或不可信 authority 拒绝新启动。隔离真实部署测试检查了所启动进程的 CLI 参数与公开 MCP 的 fail-closed 响应。
- **preflight / Packet / launch guard：**`tools/codex-session-bridge/src/orchestration/preflight.ts`、`context-contract.ts`、`harness-context-source.ts`、`context-assembler.ts`、`implementation-launcher.ts`、`src/harness/execution-model.ts`；`test/orchestration-preflight.test.ts`、`test/orchestration-context.test.ts`、`test/implementation-launcher.test.ts`。事实记录 YCA 进程 PATH、工具与 fallback、Node/npm、包 manifest/lockfile、模块可解析性、观察时间和失效语义；Assembler 只读。authority 可声明 `dependency_packages`，缺失/漂移在首次 reservation 前及 dispatch guard 中拒绝；已接受的同一 request 仍优先只读 reconcile。
- **Context Plan / source provenance：**`tools/codex-session-bridge/src/orchestration/context-plan-contract.ts`、`document-adapter.ts`、`scripts/validate-context-plan.mjs`、`.workflow/skills/ticket-design/SKILL.md`。模板与 parser 使用四个 ASCII 标签，Notes 落盘后可用同一 adapter 验证。Spec 的 canonical 引用、缺失的本地镜像、外层真实观察/失败及冲突来源保留各自状态和出处；Assembler 不进行网络读取。
- **模型与成本：**根 `AGENTS.md`、`.workflow/skills/engineering-workflow/SKILL.md`、`tools/codex-session-bridge/src/model-policy.js`、`src/manager.js`、`src/mcp.js`、`src/orchestration/execution-operations.ts`；`test/bridge.test.js`。低层默认与 MCP 描述共用 `gpt-6-sol medium`；高层实际选择仍取可信 authority snapshot 并经 catalog。受保护 receipt 增加初始 prompt UTF-8 字节、引用及重复引用数；Packet 保留自身字节/引用计数并只从 durable run event 汇总 usage。ORCH-003 的 9,946,053 raw input（9,810,816 cached）仅为历史异常基线；fixture 的初始 prompt 小于 4096 字节，未据此推断真实 token 降幅。
- **验证：**Bridge 直接测试 `node --test test/implementation-launcher.test.ts test/orchestration-context.test.ts test/orchestration-preflight.test.ts test/bridge.test.js` 为 47/47；`npm run typecheck` exit 0；Notes validator 为 `CONTEXT_PLAN_OBSERVED`。Control Center `npm test` 首轮 51/52，唯一失败是当前 worktree 未生成 Harness UI，`npm run build:ui` exit 0 后，受影响的真实部署与独立 YCA 测试定向复跑 2/2；配置定向测试 1/1。`git diff --check` exit 0。测试均为隔离 fixture；构建产物在忽略目录。
- **Review / Acceptance：**本次 review policy 为 delegated，接收方为外层 Emilia；fresh primary Review pending，Acceptance pending。未改 production authority 配置、未重启 production YCA、未 deploy，未对真实授权 Ticket 执行高层模型 launch；不能称生产已启用或日常稳定。#102 validation diagnostics、#103 review authority 激活（依赖 #93）、#104 深层 token profiling 保持独立 follow-up。
- **下一步：**外层核对本 handoff 与当前未提交 diff，启动 fresh primary Review。Review 后由外层受控 gate 处理 production authority/release/真实链路验收；本 implementation session 到此停止。

## Fix Handoff（2026-09-23）

- **状态：**`BUGFIX101-STD-01`、`BUGFIX101-SPEC-01`、`BUGFIX101-SPEC-02` 均为 `fixed`，尚未经过 fresh focused re-review；原 fixed point `b4d48564c6d1798dfe82f6c3822fb6d9a556adde`，改动仍未提交。
- **修复：**Git 与 pwsh fallback 经过 5 秒有界执行探测，失败标 unavailable 并附原因；Packet 和 launcher 共用可信 authority policy 的显式 `dependency_packages`，缺失清单拒绝首次 reserve，dispatch 前仍重检，既有 request 仍只读 reconcile；公开 Context Packet 可从宿主注入的 `manager.canonicalSpecObservations` 消费带 URL、revision、observed_at、digest 和 provenance 的外层 Spec 观察，失败为 unavailable，无记录为 reference-only，Assembler 不联网。
- **验证：**失效工具 fixture 与缺失依赖/省略清单、公开 Packet observed/unavailable 路径均有定向断言；合并相关测试 30/30，`npm run typecheck` exit 0，`git diff --check` exit 0。未跑 full suite、真实 production 链路或 Acceptance；未执行 Review 自审。

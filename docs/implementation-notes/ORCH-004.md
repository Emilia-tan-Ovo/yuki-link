# ORCH-004 / #94 — Implementation Notes

状态：已确认。Owner 在当前对话确认采用 **Proposal D：固定入口契约 + versioned authority policy + caller 前置条件**。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/94

Source Spec：https://github.com/Emilia-tan-Ovo/yuki-link/issues/89

前置基础：ORCH-002 / #91 的 durable execution operation、request fingerprint、guarded dispatch、receipt 与 read-only reconcile。

## Implementation Notes

- **入口契约与 invariant：** `start_ticket_implementation` 使用版本化 typed launch contract；当前 contract 固定 `ticket-implementation + delegated + Main + fresh`。这些是当前入口的产品语义，policy/profile 不能覆盖。跨版本结构性 invariant 继续由 schema/journal/state transition/exact lookup/binding 强制：相同 request 不重复执行、不同 payload 冲突、先 durable intent 后模型副作用、unknown 不盲重放、归属不得自相矛盾。
- **策略来源：** 在 Orchestration application layer 增加最小 `ImplementationLaunchPolicySource` seam，消费由可信服务配置激活的 immutable/versioned policy snapshot；snapshot 至少包含 schema/version、policy id/revision/digest、project/action/workflow applicability、支持的 launch contract version、model/reasoning policy、permission-selection strategy、必要 preflight requirements 与 authority references。它只表达当前 launcher 需要的机械规则，不实现通用 policy engine、配置管理平台或运行时自然语言规则解释。
- **授权来源：** policy 只说明“怎样启动”，不证明“这张 Ticket 已被允许启动”。Implementation launcher 必须通过最小可信 authorization adapter 验证 Ticket + action + 授权终点 + 适用版本；不能仅凭 `decision_ref` 字符串、Workflow phase、Context readiness 或 caller 文本推断已授权。authorization reference 只是定位符，引用本身不构成授权。
- **public input：** 保持小接口，但允许 caller 用前置条件约束系统。接受 `ticket_id`、`request_id`、准备时观察到的 `expected`（Workflow revision、完整 subject/content identity 比较值、policy identity/digest、关键 Notes identity）、bounded `current_delta`，以及必要时可验证的 `authorization_ref`。这些字段只用于 compare-and-reject；系统必须重新读取权威来源，caller 不能把 expected 值安装成当前事实。
- **禁止 caller 覆盖：** 不公开 `review_policy`、destination、既有 session/thread、`permissions`、任意 cwd、完整 prompt、并发开关、provider implementation 或自报的授权结论。Main 的“种类”固定，但真实 Main Conversation id 从 Ticket registration 读取；权限必须解析并冻结，但具体权限值从 Owner 当前原生配置解析，不硬编码 `danger-full-access + on-request`。
- **双层 durable identity：** 同一次 #91 reserve 原子关联 caller request fingerprint 与 protected execution fingerprint。caller fingerprint 只覆盖版本化 public request 的稳定语义输入，不混入时间、随机 packet_id 或重新查询得到的环境值；protected fingerprint 覆盖已接受 contract、policy revision/digest、authorization identity、Workflow/Git identity、Main destination、prompt digest 与 launch selection。旧 `execution-protected-v1` journal 保持可读/可 reconcile，不给旧 operation 事后补造 delegated/policy 事实。
- **retry / policy upgrade：** 先查已有 `(ticket_id, request_id)`，再解析新的 policy/environment。已接受 operation 永远按其冻结 snapshot 恢复；policy 升级不重解释旧 operation。相同 request 改变 expected/policy semantic payload 返回 conflict；新 request 使用过期 policy expectation 时要求重新 prepare。工作树或 policy source 暂时不可用也不应阻断对已知 operation 的只读 query/reconcile。
- **执行编排：** 对新请求执行 authority + Context/Git/Workflow/recording/model-line/environment preflight → durable reserve → `SessionManager.startGuarded()` → exact Runtime receipt → `markStarted` → Main `bind`。调用 manager 时省略 `permissions`，复用 native resolver；在 post-await 同步 guard 中最终重查 policy/authorization、recording、Workflow revision、完整 Git identity、Main claim 与 active model line，并记录实际 permission snapshot。
- **MCP gate 与恢复：** 高层 launcher 必须区分“已有 request 的只读恢复”和“首次新副作用”。不得让通用 `new-side-effect` 外层 recording gate 在进入 action 前阻断已接受 request 的 query/reconcile；只有确认这是新 launch 后才执行新的副作用门禁。
- **失败语义：** policy/source 缺失、digest/revision 不符、applicability 冲突、版本不兼容、Git identity 不完整、Workflow 漂移、权限解析失败或 execution coverage 不足时 fail-closed，不回退到内置默认、不静默降级。可选说明缺失可显式 degraded，但启动安全事实不可缺。start/bind/journal 回执未知进入 `reconciliation-required`，不自动 start/resume/bind。
- **错误可解释性：** receipt/error 至少能定位 contract、policy source/version/digest、authorization ref、preflight、实际 frozen permissions、operation/session/run/Main identity、recording/reconciliation；错误包含可定位的 source ref、expected/observed、side-effect state 与 reprepare 建议。版本/digest 只用于定位、阻断与审计，不宣称它们能证明 policy 本身“正确”。
- **保证范围：** 本票只保证通过 `start_ticket_implementation` 高层入口的语义；低层 primitives 尚保留时不能宣称整个环境结构性不可绕过。不扩入 Review/Acceptance launcher、Memory、Provider implementation、通用 policy engine/config platform、capability-profile 收口或最终真实协作链验收。

### 实现顺序与验证

1. 为 implementation contract / policy snapshot / caller fingerprint 扩展 versioned durable schema 与 receipt，同时保持 #91 v1 journal/reconcile 兼容。
2. 新增最小 `ImplementationLaunchPolicySource` 与 Ticket authorization seam，明确可信激活来源、revision/digest/applicability；不建设通用 policy engine。
3. 新增薄的 Implementation launcher 与 deterministic prompt builder，使用 Context references + current delta；prompt 不复制完整聊天、Issue/Spec、Notes、大 diff 或日志。
4. 按“existing request first → new-request preflight → reserve → startGuarded → started → Main bind/reconcile”接线；修正高层 MCP gate 使旧 request 的只读恢复不被 new-side-effect gate 误挡。
5. 通过公开 MCP/API + 真实 Harness/Journal + 可控 manager adapter 定向验证：固定 delegated/Main/fresh contract；expected 前置条件；policy/authorization 漂移；permission snapshot；same-request retry/payload conflict；post-await guard；reserve/start/bind/append unknown 的 restart recovery。测试外部 receipt/journal/实际执行数量，不以 helper 调用顺序作为主要证据。
6. 实现模型只运行直接驱动红→绿的最小定向测试与必要 typecheck；full suite、Git/GitHub、checkpoint/Harness phase recording 由 Emilia + YCA 完成。Implementation session 不执行最终 Review。

低风险细节：局部 DTO/helper 命名、文件内拆分和 fixture 组织按现有项目约定决定，不重开架构讨论。

### Context Plan

- **Core：** GitHub #94 最新正文、本 Notes、根 `AGENTS.md`、当前 `.local/workflow-state/ORCH-004.md`；`tools/codex-session-bridge/src/orchestration/execution-operations.ts`、`tools/codex-session-bridge/src/harness/execution-model.ts`、`tools/codex-session-bridge/src/manager.js`、`tools/codex-session-bridge/src/mcp.js`；直接测试入口为 `tools/codex-session-bridge/test/orchestration-execution.test.ts` 与新的 public implementation-launcher test。
- **Related：** GitHub #89 的 Enforced Rules / high-level API / capability exposure / Testing Decisions；GitHub #91 与 `docs/implementation-notes/ORCH-002.md`；`tools/codex-session-bridge/src/permissions.js`、`tools/codex-session-bridge/src/harness/workflow-model.ts`、`tools/codex-session-bridge/src/orchestration/context-assembler.ts`、`tools/codex-session-bridge/src/orchestration/harness-context-source.ts`。Related 按需读取，不默认全文灌入。
- **Retrieval：** 定向搜索 `startGuarded`、`runtimeRequestId`、`guardDispatch`、`markStarted`、`bind`、`reconcile`、`permissionSelectionFingerprint`、`authorizationValidator`、`action_readiness`、`MODEL_LINE_BUSY`、`RECORDING_OUTCOME_UNKNOWN`、`gateHarnessExecution`。
- **Expansion triggers：** authority 激活/authorization source 无法确定、v1/v2 journal 兼容不清、caller retry 无法先于动态 preflight 判定、最终 guard 无法验证 policy/authorization、actual permission snapshot 无法进入 receipt、或 public seam 无法安全表达 unknown recovery 时，扩大最小必要调查；correctness 优先，但不扩产品范围。

## Implementation Handoff

- **来源：** GitHub #94、GitHub #89、本文 Owner-confirmed Implementation Notes；fixed point `bf149f9217201c52355dcfb8f23efcada4f1084f`。
- **身份：** worktree `C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/orch-004`；branch `codex/orch-004-delegated-implementation-launcher`；实现内容 commit `a99183e2cd16ead264c9a27f3607e76cce645a9e`。该 commit 仅包含本文、launcher/schema/MCP/service-config 接线与直接测试共 7 个本票文件。
- **范围：** 新增 public `start_ticket_implementation`；固定 `ticket-implementation / delegated / Main / fresh` contract；从显式 authority JSON source 读取 versioned policy 与 Ticket authorization；caller `expected` 仅 compare-and-reject；新增 `execution-protected-v2` durable snapshot/receipt 并保留 v1 回放；按 existing-request-first、new-request preflight、reserve、`startGuarded`、started、Main bind/reconcile 编排；省略 permissions 参数并在 receipt 记录实际 frozen snapshot。未扩入 Review/Acceptance launcher、Memory、Provider implementation、capability profile 或真实最终协作链验收。
- **TDD 红灯：** `node --test test/implementation-launcher.test.ts` 首次退出码 1，原因为 `ERR_MODULE_NOT_FOUND`，证明新的高层 seam 尚不存在；随后最小实现推进到绿。
- **定向测试：** `node --test test/implementation-launcher.test.ts`，退出码 0，7/7；覆盖固定 contract、authority refresh、expected/policy drift、same-request conflict/retry、permission snapshot、unknown bind restart recovery 与 public MCP gate。
- **兼容回归：** `node --test test/orchestration-execution.test.ts`，退出码 0，12/12；`node --test test/harness-execution-gate.test.ts`，退出码 0，10/10。
- **静态与入口验证：** `npm run typecheck`，退出码 0；`node src/main.js --help`，退出码 0，确认 `--implementation-launch-authority` 可解析并展示。
- **未运行：** 未运行 full suite、真实 Codex/permission resolver、真实 authority 配置与最终协作链验收；依约交由 Emilia + YCA 后续执行。本 implementation session 未执行 Review。
- **Review policy：** `delegated`；接收方 Emilia；primary Review 状态 `pending`，必须由 fresh reviewer 基于 fixed point、上述 commit、本文与测试证据执行。
- **Finding / risks：** 当前没有 Review finding；由于 Review 尚未执行，不作“零 finding 已通过”声明。真实服务启用前需由运行层提供符合 schema 的绝对路径 authority JSON；缺失或失效时 launcher fail-closed。
- **下一步：** Emilia 核对 handoff-only commit 与最终 HEAD 后更新 Harness/checkpoint，运行 full suite，并启动 fresh primary reviewer；不得复用本 implementation context。

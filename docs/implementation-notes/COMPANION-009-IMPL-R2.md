# COMPANION-009 Implementation Notes

Source: GitHub #134 — COMPANION-009「微信真实交流，与桌面共用陪伴记忆」
Source Spec: GitHub #125
Implementation fixed point: `16a065cd44a9fd1525a1e5336d862a4e2fe25b13`
Candidate-only legacy slice: `a57723d31d939becf71852cff9a55da33951d5d4` (merge-base `e0ac8ab125c48be50717a56dc59d0224d25c5a62`)

状态：ticket-design 已完成；2026-09-26 与 2026-09-29 两轮 Astra high 设计复审均已写入 GitHub #134。Owner 于 2026-09-29 明确要求开始 implementation，因此第二次复审中的同库独立 `memory_revision` 技术方案视为本轮已确认实现方向。实现必须 fresh session；旧 009 分支仅作为候选 delta，不直接 merge 历史。

## Implementation Decisions

- **唯一会话 / 记忆源：**微信必须进入现有 Desktop `BackendSession` / worker / `conversation.sqlite`；`messages` 是近期已提交聊天，`companion_memories` + `companion_context` 是唯一有效长期陪伴记忆。不得另建微信长期记忆库或会话状态机。
- **窄微信能力边界：**009 只允许文字对话、显式 Companion Memory list/remember/correct/forget、operation lookup/cancel。不得转发通用 worker command、`cardCommand`、DSH/YCA、Workflow launcher 或工程 stop。`source/origin=wechat` 只表示来源，绝不能转换成 `desktop-user-action` 或其他工程授权。
- **Binding authority：**Desktop 主进程是扫码候选、确认、暂停、恢复、解绑、认证失效的唯一 authority。每次绑定产生不可复用 binding epoch；异步确认及每个 await / backend admission / 网络出站前都重验当前 authority。暂停/解绑停止该频道 admission，失效选择码和未发送快照，只取消本频道请求，不关闭共享 BackendSession。
- **Operation / request / generation 分离：**持久 operation identity 不绑定 worker generation；generation 只拦截旧异步回包。worker requestId 必须满足当前 `validRequestId()`。同一 `conversation.sqlite` 增加最小 operation receipt，聊天 receipt 与 messages 同事务，记忆 receipt 与 active/cutoff/revision 同事务；reopen 只读 reconcile，unknown 不自动重跑。
- **Memory revision：**`recent_context_after_rowid` 只负责 history 截断；在同库单例元数据维护严格递增 `memory_revision`，与有效记忆变更同事务提交。list、普通回复和含事实管理结果携带生成 revision；更正/遗忘成功后旧 revision 的尚未发送快照失效，普通回复不自动重跑，已进入 transport 的部分只记录真实结果。
- **Typed backend outcome：**微信 backend port 区分 committed、确定未受理/拒绝、cancelled、unknown，并携带安全 reason code。busy 不后台重试；无效命令/过期选择码返回本地引导，不写 messages、不调用模型。
- **Transport 证据：**登录、updates、send 分别验证业务成功。HTTP 200、空对象、生成文本或扫码成功均不能升级为连接/投递成功。分段保存 accepted/failed/unknown；矛盾/无法核实回包归 unknown；unknown 不自动重发。
- **真实验收分层：**本地 COMMIT → 上游业务接受 → 手机实际可见三层独立。mock / adapter tests 不能替代真实微信。
- **旧切片迁移：**从最新主线 fresh worktree 实现。可复用旧八文件中的模块拆分、无损 ID、严格入站过滤、原 inbound context token、final-only 投影、逐段证据、unknown 不重试；重做 lifecycle/reconciliation/revision/outcome/protocol 分类，不 merge 旧分支历史，不覆盖主线 worker/main。
- **第三方声明：**实际整合时更新 `THIRD_PARTY_NOTICES.md` 当前“未复制微信”声明，并按实际复用核对 AAAAGENT 固定版本及 Tencent/openclaw-weixin MIT 许可随包内容。

## Implementation Sequence

1. 将旧独立 adapter 八文件作为候选 delta 迁入当前 fresh worktree，不带旧 Git 历史。
2. 先完成 `conversation.sqlite` schema migration：operation receipt + `memory_revision`，补事务和 reopen tests。
3. 接 shared worker/session 的窄 backend port 与 typed outcomes，保持 Desktop typed/voice/engineering 现有行为不回退。
4. 收紧 WeChat binding/service/conversation 的 epoch、pause/unbind、reconciliation、snapshot revision 与 protocol outcome。
5. 在可信 Electron main/preload/renderer/settings/credential 边界接入微信 UI/配置，不开放工程命令。
6. 更新 package / notices / license 与必要打包资源。
7. implementation session 仅跑直接相关定向测试和必要 typecheck/check；完整 suites 由 Emilia + YCA 在 handoff 后确定性执行。
8. delegated handoff 后停止，由上层启动 fresh primary Review；真实微信 external gate 在 Review/Acceptance 后由 Owner 实际扫码验证。

## Deferred / Boundaries

- 010 的微信工程卡确认/查询/停止与结果通知不在本票。
- 011 的主动陪伴/定时通知不在本票。
- 不自动导入私人微信历史，不承诺第三方/备份/模型日志物理删除。
- 不新造通用任务恢复引擎、第二份 Companion Memory 或全域故障矩阵。

### Context Plan

- **Core:** GitHub #134 当前 Acceptance Criteria 与完整 Implementation Notes；本文件；根 `AGENTS.md`；fixed point `16a065cd44a9fd1525a1e5336d862a4e2fe25b13`；`tools/companion-desktop/backend/{sqlite-memory,dialogue-pipeline,session,worker}.mjs`；`tools/companion-desktop/desktop/electron/{main,preload,transport,settings-store}.mjs/cjs`；`tools/companion-desktop/desktop/turn-contract.mjs`；直接相关 Desktop tests。
- **Related:** GitHub #125 US06–11/US32–33、AC03/AC13/AC14；`docs/implementation-notes/COMPANION-002.md` 的单 SQLite Memory/cutoff 契约；005–008 当前 engineering card/dispatch/continuation/control 边界；旧候选 `a57723d31d939becf71852cff9a55da33951d5d4:tools/companion-desktop/desktop/wechat/**` 与两组 wechat tests，仅用于择优迁移。
- **Retrieval:** 按 `BackendSession.submit/cancel/memoryMutation/cardCommand`、`SqliteMemoryStore.appendTurn/change/history`、worker generation/identity、Electron trusted IPC、EngineeringCardStore `desktop-user-action`、旧候选 `WeChatService/WeChatConversation/ChannelStore/backendPort` 定位；需要协议细节时再读 #134 内 pinned AAAAGENT/Tencent 引用。
- **Expansion triggers:** 当前主线接口与旧候选语义冲突；operation receipt 无法与 SQLite 事务闭合；memory revision 无法在不复制事实源的前提下失效待发快照；真实协议缺必要身份/新鲜度/业务成功字段；微信接线会暴露工程 authority 或破坏现有 Desktop typed/voice/engineering 生命周期时，扩大到对应直接契约并停在本票边界内。

## Implementation Handoff（2026-09-29）

- **来源与身份：**GitHub #134，Source Spec #125，本文 R2 Notes；worktree `.local/worktrees/companion-009-implementation-v2`，branch `codex/companion-009-wechat-v2`，fixed point / 开始 HEAD `16a065cd44a9fd1525a1e5336d862a4e2fe25b13`。旧候选 `a57723d31d939becf71852cff9a55da33951d5d4` 只提取八个微信专用文件，没有合并旧历史或覆盖主线共享文件。
- **实现范围：**`conversation.sqlite` v3 在原库新增最小 `companion_operations` receipt、单调 `memory_revision`，聊天和记忆 receipt 分别与事实同事务提交；worker 增加只读 lookup 和仅文字/显式记忆的微信窄指令，出站只投影 finalText、ID、revision、typed outcome。微信 Channel 加密保存绑定、claim/cursor/逐段投递证据，主进程负责扫码候选、本机确认、暂停/解绑和 epoch 撤销；断线/重启只核对旧 operation，不自动重跑或重发。受信窗口展示本地 QR、连接与投递状态；本地 QR 依赖固定为 `qrcode@1.5.4`，更新 AAAAGENT / Tencent 来源与随包许可。
- **验证内容：**`node --test test/sqlite-memory.test.mjs test/wechat-conversation.test.mjs test/wechat-transport.test.mjs test/wechat-worker.test.mjs test/renderer.test.mjs test/turn-ipc.test.mjs`：78/78 通过，退出码 0。覆盖 v0/v1/v2→v3 保留数据、消息/receipt 同事务、新 generation lookup 不重复模型、worker busy/invalid、Desktop 合成事实→微信召回→微信更正/遗忘→Desktop 后续 prompt、异步本地确认撤销、选择码、分段 unknown 与记忆变更后旧快照失效。`npm run check`、`npm ls qrcode --depth=0` 均退出码 0。测试使用本地假 provider/transport/账号，未使用真实密钥。
- **已知边界：**未运行 Windows 安装包构建、真实扫码/网络/DeepSeek/手机可见验收；若上游真实响应缺少必要身份、新鲜度或业务成功字段，频道将停在 `protocol_mismatch`，需在 Acceptance 核对真实等价证据，不能放宽校验当作通过。单机加密存储不可用时微信不可用，桌面文字路径仍可启动。微信语音、设备、工程控制、主动通知与旧历史物理删除均不属 #134。
- **Review policy：**本轮 `delegated`，由 Emilia/YCA 上层接收本 handoff，针对提交内容从 fixed point 启动 fresh primary Review；本 implementation 不执行 Review。Review finding/结果均 pending，未宣称 Acceptance 通过。
- **Commit 与后续：**实现提交的精确 SHA、最终工作区状态及测试绑定记录在本 worktree `.local/workflow-state/COMPANION-009-IMPL-R2.md` 的 post-commit 更新；后续先独立 Review，再由 Owner 参与真实微信 external gate。未 push、未部署、未合并。

# YCA-006 — Codex 原生权限选择、继承与旧会话兼容

**What to build:** AI 助手创建 Codex session 时能够采用有效本机默认或显式选择的原生权限模式，立即取得所用模式记录；同一 session 可按该模式实际读写、执行命令并续聊，既有会话、历史和请求重试保持兼容。

**Blocked by:** None — 基于既有 Codex Bridge 实现，无 A 阶段技术依赖；按已确认优先级在 A2 之后推进 B。

**Status:** completed — ticket-design、实现、修后双轴审查、自动化回归、隔离真实权限验收、常驻部署及 ChatGPT → resident YCA → Codex 最终端到端验收均已完成；不把一次验收扩大表述为长期稳定使用。

**GitHub Issue:** [#6](https://github.com/Emilia-tan-Ovo/yuki-link/issues/6) — 实现与最终验收已完成，随本收尾记录关闭。

**Spec:** [已审阅规范](../../specs/yuki-computer-agent.md)；User Stories 21～26、32～33；B 权限条款、全部相关会话/幂等兼容要求及 CLI 版本事实；B-AC1～4、AC8，别名见[索引](README.md)。

## 范围与明确不做

- 核验服务实际使用的 CLI、有效配置来源及原生模式参数。未指定时采用本机默认，不把 Full Access 固定降为只读；显式选择按实际 CLI 支持处理，不猜测或静默替换。
- 新 session 创建时记录并返回实际采用的模式，续聊沿用该模式。本机默认后续变化不能静默改变该 session 的执行能力。
- 权限选择、实际读写/命令执行、续聊和旧记录兼容一起交付，不能先交新权限入口再把旧 session 安全兼容留给后票。
- 旧 session 不静默升级；无需迁移历史权限，改变模式时新建 session。新增权限输入参与请求一致性判断，旧请求映射继续按原语义重试。
- 原生配置接入涉及的用户启用状态予以尊重，不为过渡或测试方便新增统一禁用 MCP/Plugins 的行为；专项加载与真实调用验收属于 YCA-007。
- 不做历史权限迁移、会话内权限切换、自建批准平台、强隔离、app-server 迁移或强制 worktree；Full Access 不构成任何无关操作授权。

## 验收标准

- [x] B-AC1：未指定权限创建 session，记录并返回有效本机默认；在 Full Access 配置下不被降成只读。显式选择另一受支持原生模式也有输入、生效记录与行为证据。
- [x] B-AC2：经 ChatGPT/YCA 创建的同一个 Full Access session 完成实际文件读取、创建/修改和命令执行，随后续聊核对结果和上下文；用 CLI 配置及实际文件/命令结果证明，不依靠模型自述。
- [x] B-AC3：后续消息继承 session 模式；在可控测试配置中改变本机默认，已创建 session 不静默切换。无需修改用户全局配置完成测试。
- [x] B-AC4：使用旧版 session/run/request 夹具验证历史可读、旧会话可续用且不升级、原请求重试不新建运行；换模式可直接创建新 session，无需历史迁移。
- [x] 新请求的权限输入参与幂等一致性判定；并发、重试与持久化失败不误发新运行，默认字段省略等旧请求形式维持原语义。
- [x] B-AC8：模型/reasoning 选择、准确 thread 续聊、send/output/status/stop、HTTP 重连、持久化失败及恢复不重放副作用通过针对性回归。
- [x] 现有 runtime、历史、认证和连接引用保留；A 不受本票未完成或 CLI 核验失败影响，实际有效权限及未验证项在文档中明确。

## 可复现验收方式

1. 先核验当前 CLI 的原生参数和配置解析；用无敏感内容的测试配置覆盖默认、显式选择、缺失字段和不支持模式。具体参数由证据决定，不预先指定“Full Access”标签等于哪组旗标。
2. 使用临时 runtime 和旧格式夹具运行现有会话管理/存储测试，验证老数据读取、原请求重试、新权限指纹、配置继承和失败恢复；不迁移或修改真实历史做实验。
3. 经既有连接用受控文件与命令，在同一 Full Access session 完成实际操作和续聊。代表性验证模型切换与停止，不无故重复付费矩阵。
4. 保留该验收 session 的标识、非敏感权限记录及文件结果，供 YCA-007 在同一 session 接续 Skill/Context7 验收。真实 session 不可续用时如实记录，并以一个新 session 重现合并闭环，不伪称同一会话。

## 随交付更新的文档

更新默认权限来源、显式选择、创建返回、续聊继承、旧会话处理及 CLI 实际验证结果。区分“权限可用”与“Skill/MCP 已实际验收”，继续保留已有模型和会话操作说明。


## Implementation Notes

- 新 session 的权限由 Codex 原生 `app-server config/read` 按 session `cwd` 解析；显式权限也通过同一原生配置解析路径校验，不自行实现 TOML 或权限语义解析器。
- session 持久化版本化、可重放的权限快照。首版仅支持当前 `exec/resume` 可完整表达的 `sandbox_mode`、`approval_policy`、`approvals_reviewer` 及 `workspace-write` 相关有效细项；检测到无法可靠展开并重放的 `default_permissions` / permission profile 时明确拒绝，不静默降级。
- 每次 `exec/resume` 显式重放 session 快照，并同时钉住与该 sandbox 对应的 Codex 内置 `default_permissions` profile，防止本机默认或后续新增自定义 profile 导致旧 session 权限漂移；其余非权限配置继续遵循本机 Codex 配置。移除新 session 上现有的 `--ignore-user-config` 与统一 feature disables。
- 旧 session 缺少权限快照时按完整旧执行语义处理：`read-only + never + --ignore-user-config +` 原有 feature disables；未知或损坏的新快照不得回退到当前默认。
- 权限仅在 `start` 时选择，`send` 继承 session 快照且不允许切换。新 `start` 的幂等指纹纳入调用者权限输入；历史 request 映射继续按旧指纹兼容重试，重放检查先于重新解析本机默认。
- 自动化使用 fake resolver、临时配置与旧 runtime/request 夹具覆盖解析、冻结、并发幂等、持久化失败和恢复；最终验收必须经 ChatGPT → YCA → Codex 在同一 session 取得真实读/写/命令/diff/续聊证据。

## 本地实现与验收状态

2026-09-18：YCA-006 候选已在隔离 worktree/runtime 完成实现与审查，正式常驻 YCA 未替换。

- 当前实际 Codex CLI 为 `0.155.0-alpha.2.6`。候选通过原生 `app-server config/read` 解析 session `cwd` 下的有效权限；本机默认实测为 `danger-full-access + on-request`。新 session 持久化版本化权限快照，`exec/resume` 同时钉住 sandbox、对应 Codex 内置 permission profile、approval/reviewer 及 workspace-write 细项；旧 session 无快照时完整保留旧 `read-only + never + --ignore-user-config + feature disables` 语义。
- 无法完整重放的自定义 `default_permissions` / `permissions` profile、未知 workspace 权限字段及损坏快照明确拒绝，不静默压扁或读取当前默认。显式权限只允许在 start 创建新 session 时选择；send 继承已保存快照。新 start 的权限输入参与幂等一致性；旧 request fingerprint 在权限省略时保留兼容重放。
- Bridge 完整回归：96 tests / 95 pass / 0 fail / 1 预期 skip；Control Center：35 / 35 pass。新增测试覆盖快照冻结、真实旧格式 runtime/run/request 夹具兼容、未知/损坏权限快照、built-in profile pin、会话内权限切换明确拒绝、PermissionResolver 超时后自有 app-server 进程树实际退出，以及原有 model/reasoning/resume/status/output/stop/HTTP reconnect/持久化失败回归。
- 隔离真实 MCP → Bridge → Codex 行为验收使用 Sol medium 与临时 Git 仓库：PermissionResolver 使用独立临时 `CODEX_HOME` 作为可控配置来源，先由真实 `config/read` 解析 `danger-full-access + on-request`，默认 session 真实读取随机 source、写入 proof、以 shell 追加 `CMD_OK` 并执行 `git diff`；随后把临时默认改成 `read-only + never`，真实 `config/read` 确认新默认已变化，但原 session 续聊仍按冻结快照以 shell 成功写入 `FROZEN_SESSION_OK` 且 thread 不变。另建显式 `read-only + never` session 后实际尝试写入并取得拒绝证据，外部核对受控文件保持不变。最终 acceptance report 为 `passed=true`、`thread_resumed=true`、`frozen_session_write=true`、`read_only_write_blocked=true`。
- 修后 live 验收首次遇到一次上游 `Selected model is at capacity`，该 run 在任何 command/file 副作用前明确失败并保留失败报告；随后一次有界重试完整通过。该容量事件不作为候选成功证据，也未被静默重放。
- 独立 Sol medium 双轴审查后补齐真实旧 runtime 夹具、未知快照字段拒绝、`codex_send_message` 权限切换显式错误、MCP/运行时共享权限枚举及 B-AC3 可控默认变化真实行为验收。关于“应直接接受任意 `default_permissions` / 自定义 profile”的审查建议未采纳：当前 CLI `config/read` 不会把 profile 编译为可由 `codex exec` 完整重放的权限对象，Codex 上游也把 profile 标识与实际 `PermissionProfile` 执行快照分离；在不迁移 app-server 执行器的本票范围内，明确拒绝比静默压扁更符合权限冻结边界。
- PR #18 与修复 PR #19 合并后，Control Center 已将常驻 YCA 切换到 merge commit `4691d23bc0bfabd0460928e1790b31f6e6082088`；运行/目标/启动 commit 一致，`dirty=false`，18 工具摘要一致。
- ChatGPT → resident YCA → Codex 最终验收使用保留的受控临时 Git 仓库与 Sol medium：新 session 直接返回冻结的原生权限快照 `danger-full-access + on-request`（`source=local_codex_config`）；Codex 实际读取 `source.txt`、修改 `proof.txt`、执行 PowerShell 追加 `COMMAND_OK` 并运行 `git diff -- proof.txt`，JSONL `command_execution` 为 exit 0。随后由 ChatGPT 侧通过 YCA 独立读取文件与 Git diff，结果与 Codex 事件一致。
- 同一 YCA session 再次发送消息时复用了相同 Codex thread `01a0b23a-d36b-7b31-8a7d-7d63666b4c3d` 与同一权限快照；第二轮真实读取 `proof.txt` 后返回 `RESIDENT_RESUME_OK RESIDENT_CHAIN_OK SOURCE=RESIDENT_SOURCE_4691D23`，run 最终 `completed / exit_code=0 / error=null`。至此 B-AC1～4、幂等兼容项与 B-AC8 在常驻链路上闭环。
- 最终验收 session 与临时仓库暂时保留，供 YCA-007 接续 Skill / Context7 真实加载与调用验收。YCA-006 至此可以关闭；本记录仅声明“已实现并完成常驻真实端到端验收”，不声明长期稳定使用。

## ticket-design 建议

**建议先做。** 原生配置如何解析并记录、resume 如何继承、旧 session 缺字段如何保留语义及新旧请求指纹兼容，会直接影响权限与重复副作用。以本机 CLI 事实和现有会话契约为边界，不建立替代权限系统；这些调查不前移为 A 的条件。

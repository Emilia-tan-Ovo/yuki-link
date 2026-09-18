# YCA-007 — 在 Codex 会话中实际使用 Skill 和 Context7

**What to build:** AI 助手在采用原生权限的同一 Codex session 内，完成实际 Skill 使用及 Context7 调用，并知道其他本机 MCP/Plugins 到底处于安装、识别、加载还是已调用状态。

**Blocked by:** YCA-006 — Codex 原生权限选择、继承与旧会话兼容；需要其实际可操作且可继承模式的 session 来完成同会话验收。

**Status:** completed — 复用 YCA-006 常驻验收 session 完成 Skill 实际使用、Context7 真实 MCP 调用、四层环境状态核对及变化相关回归；未发现需要新增生产环境注入代码的缺口。

**GitHub Issue:** [#7](https://github.com/Emilia-tan-Ovo/yuki-link/issues/7) — 实现与最终验收已完成，随本收尾记录关闭。

**Spec:** [已审阅规范](../../specs/yuki-computer-agent.md)；User Stories 26～33；B 本机环境条款及 CLI/插件待验证事实；B-AC5～9，并串联 B-AC2，别名见[索引](README.md)。

## 范围与明确不做

- 核对 Bridge 服务实际使用的 CLI、配置和所需环境，修复阻止实际加载/调用的接入缺口，尊重用户原有启用与禁用状态。
- 验证 Skills 发现，并让 Codex 自己实际使用一个适合验收任务的本机 Skill；Bridge 只传输任务和管理运行，不解释或编排 Skill 流程。
- 在同一 session 中完成 Context7 真实调用，作为最低必验 MCP 样本；它不是插件白名单，也不要求所有已安装插件都通过。
- 区分已安装、CLI 识别、Bridge session 加载及实际调用成功；缺少证据时标为未验证，非必验兼容问题单独记录。
- 不重新设计权限系统，不统一禁用或全部强启插件，不承诺桌面端等价，不做插件编排框架、GUI、历史查看工具或全插件兼容工程。

## 验收标准

- [x] B-AC5：在权限验收 session 中确认 Skills 发现，并实际使用至少一个合适本机 Skill；存在符合其流程的过程/产物证据，不仅是列目录或在回复中提到名称。
- [x] B-AC6：该 Bridge session 实际调用 Context7，得到与验收任务相关的文档结果及可核对调用证据；安装清单和模型自述不能替代。
- [x] 串联 B-AC2：同一 session 已完成或再次完成文件读写、命令执行与续聊，再完成 Skill/Context7 流程；记录 session/thread 标识和各步骤证据，避免用多个 session 拼成“同会话通过”。
- [x] B-AC7：记录用户启用状态和四层可用性证据，未实测项明确标记；不统一关闭其他 MCP/Plugins，也不启用用户已关闭项目。
- [x] B-AC8：环境接入后同一 thread 续聊、模型选择、send/output/status/stop、历史和重试能力仍通过相关回归；复用 YCA-006 已有证据，只补变化相关测试。
- [x] B-AC9：非必验插件失败单独记录，不阻塞 A 和其他已可用能力；Context7 或必验 Skill 使用失败则本票对应验收未完成，不以“整体环境大体正常”替代。
- [x] 现有认证、runtime、历史和 tunnel/key 保留；环境核对或验收产物不暴露凭据、完整配置或无关私有资料。

## 可复现验收方式

1. 以当前 CLI 和服务的实际环境为准，读取非敏感安装/识别信息；对照用户启用状态判断是否有 Bridge 显式覆盖。只核对与本票有关的字段，不复制完整个人配置。
2. 使用 YCA-006 验收 session，选择一个适合受控任务、无需无关外部写入的 Skill，由 Codex 自己读取并执行其适用流程；保留最终产物和调用过程证据。
3. 在同一 session 进行与任务相关的 Context7 实际文档查询，核对工具事件和返回资料，再续聊使用结果。若必须新建验收 session，则在该新 session 重现读写/命令/续聊/Skill/Context7 整个闭环。
4. 在 ChatGPT → 既有 YCA 连接上观察上述结果。自动化测试复用现有 executor/会话/存储接缝，真实模型调用集中在必要流程，不重复所有模型和插件。
5. 用简明结果表分别标记安装、识别、加载、调用证据及问题。非必验插件问题不扩成新的前置工程；真实阻塞时说明最小替代方案并交回用户决定范围。

## 实施与验收状态

2026-09-18：YCA-007 未新增生产代码。YCA-006 已使新 session 继承现有 Codex 非权限配置；本票以常驻 YCA 和当前真实 Codex 环境完成加载/调用实证，并将环境事实记录下来。

- 验收复用 YCA-006 保留的常驻 session `542adfa9-4d3c-4d24-b8cd-885c2c0261c7`，Codex thread 始终为 `01a0b23a-d36b-7b31-8a7d-7d63666b4c3d`。该 session 之前已完成真实文件读写、PowerShell 命令、Git diff 与续聊；本票没有用多个 session 拼接同会话证据。
- **Skill：** 同一 thread 通过 `$code-review` 实际执行本机 Skill。运行按 Skill 流程固定比较点、处理无独立 spec 的分支、执行 Standards 检查并产出两轴结论；过程事件包含实际 Git 命令与协作等待，最终 run 为 `completed / exit_code=0`。这不是仅列目录或在回复里提到 Skill 名称。
- **ChatGPT 公开边界：** 上述 Skill 与随后 Context7 请求均由本次 ChatGPT 对话直接调用已注册的常驻 YCA `codex_send_message / codex_get_status / codex_get_output` 工具发起并观察；没有用本地候选 HTTP、直接 CLI 脚本或模型自述替代 ChatGPT → 既有 YCA 连接。YCA 返回的 session/run 标识和 durable JSONL 事件就是本次公开边界证据。
- **Context7：** 当前 Codex CLI 为 `0.155.0-alpha.9`。CLI `mcp list` 将 `context7` 识别为 enabled；同一 thread 随后产生真实 `mcp_tool_call`：先调用 `context7.resolve-library-id` 解析 Node.js 为 `/nodejs/node`，再两次调用 `context7.query-docs`，取得 Node.js 官方 `doc/api/fs.md` 中 `fs.promises.readFile` 返回值与 AbortSignal 说明。最终 run 为 `completed / exit_code=0`。
- 对完全相同的 Context7 send 请求重复使用同一 `request_id`，YCA 返回原 `run_id` 且 `deduplicated=true`，没有再次调用模型或 MCP；环境接入后原有历史、thread、send/output/status 与请求幂等继续成立。stop、模型/reasoning 与恢复等未变化路径复用 YCA-006 已完成的回归证据，不重复付费矩阵。
- 当前 `~/.codex/config.toml` 的 Context7 配置含 `type` 与 `url` 两个字段；CLI 会提示 `mcp_servers.context7.type` 为 unrecognized/ignored，但仍能从 `url` 识别、加载并真实调用 Context7。因此本票不修改用户全局配置；该 warning 记录为非阻塞兼容提示，不把清理冗余字段变成产品前置条件。
- MCP 四层状态：`context7` 已配置、CLI 识别 enabled、Bridge session 已加载、实际调用成功；`cua_repl` 与 `node_repl` 为 CLI 识别 enabled，但 session 加载/实际调用未验证；`codex_app` 为 CLI 识别 disabled，保持用户现状，不为验收强启。
- **动态状态 source of truth / 刷新：** “本机/安装、CLI 识别”以当次真实 `codex mcp list` / `codex plugin list` 为 source of truth；“session 加载、实际调用”以常驻 YCA 对应 run 的 `mcp_tool_call`、命令/协作事件和终态为 source of truth。这里记录的是 2026-09-18、CLI `0.155.0-alpha.9` 的点时快照，不是永久白名单。CLI 版本、用户 MCP/Plugin 配置或安装/启用状态变化后，该快照即需重新核对；相关变化至少重跑 CLI 清单和代表性的 Skill/Context7 调用，纯无关插件变化不要求重跑完整付费矩阵。Codex executable hash 变化由 YCA 在能力刷新/新 session 时动态重发现，不以本文路径为配置来源。
- Plugin 清单通过 `codex plugin list` 只读核对：当前共有 16 项显示 `installed, enabled`（包含 documents/pdf/spreadsheets/presentations/template-creator、browser/computer-use 系列、GitHub、openai-templates、sites、plugin-management 等）。本票不逐个调用它们；除必验 Context7/Skill 外，session 加载与实际调用均明确标记为未验证，不据“安装/启用”宣称可用。
- 全程未重建 tunnel/key、未清空 runtime/history、未修改认证或用户全局 Codex 配置。Codex Desktop 在验收中自动升级并更换 hash 路径后，常驻 YCA 无需重启即可通过动态 executable discovery 刷新到 `0.155.0-alpha.9`。

## 随交付更新的文档

更新本机配置/环境继承的实际规则、Skill 使用及 Context7 调用证据、插件四层状态和已知限制。明确最低验收样本、未实测能力与桌面端差异，不把历史版本清单当成永久白名单。

## ticket-design 建议

**按需，不默认重复设计。** 先复用 YCA-006 的配置继承结论并核验 CLI 的实际加载/调用；版本事实调查本身不要求进入 ticket-design。只有实际差异迫使新增或改变用户可见配置/加载契约时，才建议围绕该取舍做局部设计。已有规则能支持验收时直接完成接入验证，不重复设计或引入新框架。

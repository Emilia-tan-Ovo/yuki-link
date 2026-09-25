# COMPANION-013 Implementation Notes

Source: GitHub #139 / Source Spec #125 Post-M1 Addendum US36 / AC15
Fixed point: `aee8f58e45d9e5d575917a5fc728fd8e8a117e85`

## Implementation Decisions

- **Role Card 产品形态：**采用单一 `RoleCardV1 = { schemaVersion: 1, text: string }`。用户编辑一整张自由文本 / Markdown 卡；默认内容用“关系 / 性格 / 称呼 / 表达风格”等中文小标题做填写引导，但标题不是语法或必填字段。当前不做固定字段表单、多角色、角色卡导入导出/市场或模板语言。
- **Role Card 语义与校验：**Role Card 只影响关系、性格、称呼和表达风格，不可改变 Emilia 固定身份、Core Prompt、真实能力、工具或授权。文本规范化为 LF、去首尾空白；拒绝空白、NUL / 非允许控制字符和超长输入；合法 emoji / Markdown 仅作为文本处理，不执行或渲染成 HTML。具体默认文案与数值上限可在 implementation 中小幅调整，但必须保持该语义。
- **Core Prompt 与 Prompt Composer：**新增独立纯 `prompt-composer` seam；Core Prompt 为产品维护的版本化规则，普通设置和 renderer 不可读取/覆盖其可编辑源。Composer 每轮显式组合：Core Prompt → Role Card → Runtime Capabilities → Companion Memory seam → Recent Conversation → 当前 user 输入。逻辑来源不要求拆成多条 system message，但来源与优先级必须可测试。
- **Provider 接口统一：**Prompt 拼装从 DeepSeek adapter 移出；provider 改为消费已组成的 `messages`，只负责 HTTP / provider 适配。preview provider 也走同一 messages interface。不能保留“Composer 拼一遍、provider 再拼一遍”的双重上下文路径。
- **Recent Conversation：**只投影已提交的 user/assistant 最终文本，保持原 role/order；继续沿用当前最近 20 条策略。本轮 user 由 Composer 最后加入且恰好一次，不按文本相等去重。系统消息、reasoning、凭据、工程日志不进入 Recent Conversation。
- **Runtime Capabilities：**由 `BackendSession` 在每次 submit 时从当前真实装配和最近请求事实生成结构化快照，不能从 renderer 文案、旧 prompt 或 Role Card 推断。至少区分 text 的 implemented / mode / unconfigured / configured / verified / unknown / offline-preview，以及 memoryManagement / voice / live2d / engineeringCards 未实现事实；工作台可达不等于 companion model 拥有工程工具。
- **真实状态失效：**`verified` 只代表本 Session 最近一次真实 provider 请求成功，不代表持续健康；真实 provider 失败后下一轮状态为 `unknown`，新 Session / provider replacement 不继承旧 verified。provider 前置拒绝（例如 busy、无配置）不能伪装成远端失败。
- **Companion Memory injection contract：**013 只提供消费 seam，不实现 Memory engine。最小 `MemoryEntryV1 = { id, text, sourceRef }`，集合带 schemaVersion；空集合合法。id 是稳定标识，sourceRef 是 opaque 可追溯引用，Composer 只携带，不解析；调用方每轮传入当次已筛选有效集合。013 不生成 ID、不召回/总结/评分、不写库、不把记忆升级为 system 规则或授权。category / confidence / validity / 生命周期留给 #127。
- **Memory 输入失败语义：**重复 id、非法字段、未知 schema 或超预算应整体拒绝组合并返回受控输入错误，不静默丢项后宣称完整使用。具体条数/字符预算允许 implementation 按低风险测试需要微调，但必须有明确上限并由 #127 消费。
- **Settings 持久化：**继续使用 Desktop `settings.json`，新增 `roleCard`；DeepSeek credential 继续只在独立加密 `credential.bin`。设置文件所有修改经统一可信主进程 store 串行提交，避免 workbench 与 Role Card 并发覆盖。
- **保存提交点：**校验 → 复制候选设置 → 同目录临时文件写入并 sync/close → rename 替换 → **替换成功后**才发布新的内存 committed snapshot。保存失败保持旧磁盘文件和旧生效 Role Card，并返回真实错误；不先改内存再写磁盘，不宣称任意断电下绝对零丢失。
- **加载/恢复默认：**旧 settings 缺 roleCard 时使用内置默认；无效 roleCard 明确警告并使用默认，不谎称自定义已生效。恢复默认是显式持久化操作，并复用相同提交路径；失败时旧 committed 值继续生效。凭据和现有 workbench 设置不得因 persona 写入丢失。
- **UI / IPC：**在既有“设置与连接”里增加“Emilia 角色卡”多行编辑区、计数、保存、恢复默认和独立状态提示。角色卡草稿与 committed 值分离；关闭/重开只恢复已提交值。使用专用 persona load / save / reset 命令与响应，不建立任意 settings patch 或 Core Prompt 编辑通道；persona 保存失败不能误触聊天 busy/generation 状态。
- **发送时快照：**main 在接受 submit 时复制**最近一次成功提交**的 Role Card，并随可信 submit 送入 worker；Runtime Capabilities 在 worker/Session 当轮生成。发送进行中保存新 Role Card 不改变当前已组成 messages，只影响保存成功后的下一次发送。Role Card 保存不重启 worker、不取消正在运行的 provider。
- **真实验收：**实现后用隔离桌面数据完成设置保存/reset/重开验证；在 Owner 另行授权后，用合成角色设定完成一次真实 DeepSeek 请求，核对实际 request 使用已保存 Role Card，并记录可见回复、耗时和请求数。一次表现只作为观察，不承诺模型永久服从风格。
- **非目标：**Prompt preview、Memory engine、私人历史导入、多角色、角色市场、Core Prompt 编辑器、Live2D/Voice、thinking UI、工程卡片、微信、后台健康轮询、自动凭据验证与长期 prompt quality benchmark均不在本票。

### Context Plan

- **Core:** GitHub #139 / US36 / AC15；本 Notes；`AGENTS.md`；fixed point；`tools/companion-desktop/backend/{dialogue-pipeline,provider,session,worker}.mjs`；`tools/companion-desktop/desktop/electron/{main,preload}.mjs/cjs`；`tools/companion-desktop/desktop/{index.html,renderer.js}`；直接相关 tests。
- **Related:** #125 Post-M1 Addendum、ID01 / ID07 / AC14；sibling `companion-v0-design/CONTEXT.md` 的 Emilia / Companion Memory 术语；`sqlite-memory.mjs` 只用于确认近期最终文本投影；`transport.mjs` 只在 generation / submit 转发需要时读取。
- **Retrieval:** 关键词 `SYSTEM`、`history().slice(-20)`、`verified`、`settingsFile`、`connection.send`；#127 仅在实现 producer/consumer 合约时窄读当前 Memory 描述。
- **Expansion triggers:** 需要 Memory engine / category/confidence/validity、跨端设置冲突、thinking/reasoning、工具授权、production 重启/部署，或当前 settings/transport 无法满足保存/快照语义时，先回报范围冲突，不自行扩票。

## Deferred Details

- 默认 Role Card 的精确措辞、输入上限、错误常量名、临时文件命名、CSS 间距与内部 helper 名称。
- settings store / main 转发的具体文件拆分只要保持上述提交点、快照和测试 seam 即可。
- Prompt preview 和更丰富 Role Card schema 等到出现真实消费者后再设计。

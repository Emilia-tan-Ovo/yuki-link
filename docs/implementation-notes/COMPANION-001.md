# COMPANION-001 Implementation Notes

Source: GitHub #126 / Source Spec #125
Fixed point: `e485170928fe25d1323d9f033239f3f3ebe4ab3e`

## Implementation Decisions

- **Windows 产品形态：**复用并改造 AAAAGENT 固定版本的 Electron main / preload / transport / 私有资源协议，交付 Yuki Link 的独立 Windows x64 桌面应用。开发态与发行态必须分开：发行产物需支持双击 EXE / installer 启动，不依赖浏览器、开发服务器、npm 命令、源码 cwd 或系统 Node。后端若继续独立 Node 进程，则随包提供受控 runtime / resources，并从 packaged resource path 解析；原生模块按实际运行 ABI 打包并做实机 smoke。
- **001 的 UI：**默认打开正常尺寸、可缩放的 Yuki Link 主窗口，而不是透明置顶桌宠抽屉。界面参考 Chatbox 等成熟聊天客户端的通用信息架构，但不复制其 GPLv3 代码、资产、图标或样式：左侧 Emilia / 日期历史与次级入口，中间 Conversation，底部多行输入与发送状态，设置/连接状态与 Engineering Workbench 入口。保留 Yuki 自己的品牌和产品结构。001 不因“漂亮”重写成 React；优先沿用 AAAAGENT 当前 DOM/CSS/esbuild renderer 与既有 IPC seam，后续确有维护压力再单独评估技术栈迁移。
- **长期对话语义（Owner 已选 A）：**001 只有一个持续的 Emilia 对话。侧栏展示按日期分组、可回看的历史，不提供“新建多个彼此隔离会话”。重启应用后可恢复可回看的既有对话；这不扩大为 002 的纠正/遗忘语义。后续微信也围绕同一个 Emilia 身份接续，不在 001 新建 conversation identity / memory scope。
- **纯文字陪伴组合：**从 AAAAGENT 陪伴后端复用 `BackendSession -> DialoguePipeline -> DeepSeek dialogue -> SQLite` 的文字路径，并使用 Emilia 的产品身份。001 必须允许在没有 TTS、ASR、Live2D、微信或工程执行器时启动和真实文字聊天；`outputMode=text` 跳过合成/播放。001 的运行组合不启动 DSH/Codex、DesktopWork、原 Codex/Harness forwarding 或微信。
- **产品 seam：**为 002 Memory 管理、003 Live2D/语音、004 工程卡片预留明确的 UI / backend capability seam，但未实现功能不可做成假按钮或伪“已连接”。现有 Yuki Harness/YCA 保持独立工程系统；001 只提供 Engineering Workbench 的真实入口/连接状态，不迁移或覆盖其数据。
- **配置与数据：**DeepSeek 凭据保持在仓库外的受限本地存储；renderer 只能看到是否已配置/验证及脱敏错误，不回显 Key。Yuki Desktop 使用独立用户数据目录；安装/升级不得覆盖现有 Yuki 工程历史，也不自动导入私人聊天。语音/Live2D 等缺项显示为后续能力未配置，不能阻断 001。
- **许可：**复用 AAAAGENT 的代码/文档时保留固定提交来源、版权、完整非商业署名许可和“已修改”说明，并提供可见 About/License 入口。Chatbox 只作为设计参考，不引入其 GPLv3 文件或资产。本票不作商业授权判断。
- **验收与测试 seam：**确定性最高层测试覆盖 renderer 输入 -> Electron IPC -> text backend -> 可替换 provider -> 可见回复，以及关闭/重开后的历史恢复和 Emilia 身份；发行 smoke 必须从 packaged unpacked EXE 或实际安装后的入口启动，确认无需开发依赖/系统 Node、可完成确定性文字回合、正常关闭并再次打开。真实 DeepSeek 往返单独记录首回复时间与配置状态；没有真实凭据/调用授权时该 AC 保持待验，不能用 mock 冒充。

## Implementation Sequence

1. 建立独立 Yuki Link Desktop 产品包边界，移植/改造 AAAAGENT Electron 壳与必要陪伴模块，保留来源声明。
2. 先打通 text-only backend composition 与 Emilia identity / SQLite / DeepSeek 配置状态，确保 003 资源缺失不阻断启动。
3. 重组 renderer 为 Yuki 主窗口，完成持续对话、日期历史、composer、设置/状态和 Engineering Workbench 入口；保留未来 capability seam。
4. 增加 Windows x64 packaging（installer + unpacked app）与 packaged resource/runtime 定位；处理 native module ABI / unpack 要求。
5. 补确定性入口测试、packaged smoke、许可/发布检查；最后在获得真实 DeepSeek 凭据与调用授权后做 AC01 真机往返并记录首回复时间。

## Deferred Details

- Electron builder/Forge 的具体配置字段、图标素材、窗口尺寸、CSS token 和组件命名按实现期最小改动决定。
- 自动更新、系统托盘、开机启动、Live2D/语音、完整记忆管理、工程卡片和微信均不在 001；不得顺手扩票。
- 代码目录命名按仓库现有结构选择一个独立 Desktop package；不得把陪伴产品代码塞进现有 Harness package。

### Context Plan

- **Core:** GitHub #126 AC；本 Notes；`AGENTS.md` / `CONTEXT.md`；当前 fixed point；直接实现入口只围绕新 Desktop package。
- **Related:** AAAAGENT `2752349bcc7f7137b8b9e4ff9cccf34026d77aad` 的 `windows/code/desktop-pet/{package.json,desktop/electron/*,desktop/{index.html,main.mjs,chat-log.ts,style.css,build-web.mjs},app/{trial-launcher.ts,trial-config.ts,trial-backend.ts,backend-session.ts},core/dialogue-pipeline.ts}`；Yuki Harness UI 仅作为 Engineering Workbench 入口边界。
- **Retrieval:** 只有在 text-only composition、历史恢复、打包 ABI 或 packaged path 需要时，定向读取 AAAAGENT memory / management 对应符号和 Electron 官方打包文档；不要重扫整个上游或历史票。
- **Expansion triggers:** 打包后 native addon ABI 不匹配；现有 trial fingerprint 阻止 packaged runtime；纯文字仍被 TTS/Live2D 强制拦截；历史读取需要改变 memory scope；任何改动触及 YCA production 或工程派发。

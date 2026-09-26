# COMPANION-003 Implementation Notes

## Phase C 无外部资源代码交付（2026-09-26）

- 基线：`4b81d1e7800608ad82177f81a484998532591894`。只实现资源契约/缺项路径与 mouth code wiring；没有导入或下载 SDK/model，没有真实 provider、麦克风或扬声器调用，没有 DSH。
- `Live2DConfigV1` 默认未配置，沿用 SettingsStore atomic queue 保存本地引用、fingerprint、SDK candidate binding 与可选 mouth override；拒绝额外字段/持久化 ready。main 的原生选择器提供模型路径，renderer 不提交路径；安全投影仅含 basename、opaque ID、计数/hash 与状态。保存成功仅是 configured candidate。
- validator 执行已确认的 256 声明项 hard limit（重复项计数）、32 textures、1MiB JSON、64MiB moc、256MiB 总预算；所有支持的已声明引用均检查路径/结构/后缀/普通文件/存在性/hash。未声明可选 motion 等不要求存在；未知引用类型拒绝。Windows 除 lstat/realpath/handle/stat 核对外，通过宿主 `pwsh.exe` 检查祖先路径 ReparsePoint；不可检查时 fail closed，不安装工具。合成空 moc/png 只证明文件契约，不证明有效 Cubism 内容。
- fingerprint 覆盖入口和全部声明文件 bytes/path；重新校验不自动接受新 hash。资源读取 seam 重验完整 manifest 和实际返回 bytes，变化/撤销使旧 binding 无效，迟到 selection/validation 不恢复旧资源。`yuki://model`、`yuki://sdk` 尚未开放，现有 app 协议仍仅服务应用目录，外部资源不复制进发布 glob。
- 同窗口加入折叠资源状态区及隐藏 canvas；未配置、缺文件、校验失败、SDK 未核对均保持 pending，不阻塞 text/voice。readiness 明确区分 `codeReady`、`implemented`、`configured`、`resourcesVerified`、`sdkLoaded`、`modelLoaded`、`drawReady`、`mouthMapped`、`talkingReady`、`ready`；本轮真实 Cubism adapter 尚未装配，`implemented=false`、`codeReady=true`、实际 `ready=false`。
- mouth setter 使用实际参数表 seam 校验 closed/open/min/max 和 Yuki gain policy，只消费 Phase B 当前 playback owner/requestId 的 started 后 RMS；静音、结束、停止、取消、错误、重连闭口，旧 callback 不能影响新 owner。没有 reasoning/TTS-ready/decode 驱动口型。默认 1.9 的上游公式局部改编已写入 THIRD_PARTY_NOTICES，原 source-available 许可保留。
- RED→GREEN：缺失 validator/mouth 模块；optional references/声明预算；SettingsStore；optional loader/runtime；播放回调；缺项 renderer；资源 ID 类型校验。最终 Phase-C targeted + 直接回归 **82/82 PASS**（7 个测试文件）；随后资源 ID 类型修复的 SettingsStore **8/8 PASS**。18 个变更 JS 模块 `node --check`、`git diff --check` PASS。
- packaged smoke 已增加 ESM 可达与缺 SDK/model 的诚实 pending 检查及 `YUKI_LIVE2D_ACTUAL_PENDING` marker；本轮**未执行** full suite/package/packaged smoke，交 Emilia/YCA 后置。上述测试均为 synthetic/code wiring，不是实际绘制/声音证据。
- **external gate / 未实现真实资源部分：**合法 SDK Core/Framework/shaders 的精确来源/版本/hash/许可、可信离线 preparation/build、真实 Cubism adapter 构造、纹理解码前后预算调用与实际 GPU 检查、moc 兼容性、drawables、真实 parameter mapping、model draw/talking 仍 pending。已有纯纹理预算 guard 与 optional loader 缺项路径；没有可信 SDK 时 production 不执行任意 JS，也不编译或 import stub SDK。**Live2D actual ready=false；#128/AC02 pending。** 当前限定代码范围无已知 blocker；上述资源和实机验收仍是后续 gate，不能据此宣称整票完成。

## Phase B 本地实现交付（2026-09-25）

- 基线：`22f6299a917fecada5fe4a0c876f55d121497fa4`。本轮仅实现 B；未实现或导入 Live2D/Cubism，未触碰 DSH。
- `backend/voice-provider.mjs`：固定 Qwen-Audio 3.0 ASR/TTS candidate；当前长期方案只开放北京区 `cn`，ASR=`qwen-audio-3.0-asr-flash`，TTS=`qwen-audio-3.0-tts-flash`，系统音色允许 `longanfengyue` / `longanlingxi` / `longanyuanfei`，默认 `longanfengyue`。严格请求与 final 响应、读取期间限额、45s/120s deadline、caller abort、无 retry。TTS 只由 worker 从 `Session.mediaText(requestId)` 取已提交正文；默认 typed 不朗读。旧 Qwen3 snapshot + Cherry 仅作为本地设置迁移输入存在，不能继续作为新请求配置。
- `desktop/media/{wav,devices,recorder-worklet}.mjs`：8–48kHz 实际采样率、mono PCM16、30s/1,440,000 samples/3MiB 录音限额；独立 main/worker WAV 验证；纯音频捕获与 drain、迟到许可/解码清理、真实输出推进后 speaking、RMS、sink API 降级和 autoplay 阻止后的显式本地播放。原始音频仅有界内存，无媒体临时文件。
- `voice-runtime.mjs` 复用 Phase A `VoiceTurnCoordinator`；scope/requestId/generation 校验与一次消费覆盖 ASR、提交、合成、播放；设备清理确认前不接受下一次录音。Memory 终态、bounded completed retention、取消提交边界保持原路径。
- SettingsStore 增加 versioned voice 字段，仍走 atomic queue；独立 `voice-private/voice-credential.bin`，由 safeStorage 加密，PowerShell 7 设置并验证用户目录 DACL。renderer 不收到 secret 或私有路径。导入成功只表示已配置，不自动验证 provider。
- UI 增加语音控制与独立设置区，区分实现、配置、权限、ASR/TTS、capture/playback、canAttempt；Live2D 聚合能力仍 false。设备刷新不暗自请求麦克风。
- 下载 allowlist：cn 使用 `dashscope-result-bj.oss-cn-beijing.aliyuncs.com`；sg 使用官方服务结果主机 `dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com`。仅精确主机 HTTPS/受控 HTTP 升级，不接受重定向、任意 URL 或私网地址。证据：[Qwen TTS 响应示例](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api)、[官方新加坡结果主机示例](https://www.alibabacloud.com/help/en/model-studio/first-call-to-image-and-video-api)。账号实际返回主机仍须实测；不匹配时明确失败，不自动扩 allowlist。
- 定向红→绿：WAV/ASR 模块缺失、voice settings 缺字段、worker voice 路由与 committed transition 缺失、devices 模块缺失、静音误判播放测试均实际观察到红项，再实现至绿。最终仅运行 `provider / voice-provider / voice-devices / voice-readiness / settings-store / voice-turn / turn-ipc / renderer` 八个测试文件：**70/70 PASS**；修改及新增 JS 的 `node --check`、`git diff --check` PASS。
- packaged smoke 仅新增未配置 readiness 与 worklet MIME 检查代码，**未运行 package/full suite/smoke**；交 Emilia/YCA 后置。当前无已知确定性实现 blocker；fresh review 尚未进行。
- 外部 gates 保持 pending：Owner 选定账号/区域/model/voice 与付费调用授权；真实 safeStorage/DACL 凭据导入；实际权限、麦克风、扬声器及完整 ASR→现有文字链→TTS→播放；真实 packaged 验收。以上 fake 结果不等于真实服务/设备 ready，也不等于 #128 AC02 完成。


- Ticket：[GitHub #128](https://github.com/Emilia-tan-Ovo/yuki-link/issues/128)。Spec：[GitHub #125](https://github.com/Emilia-tan-Ovo/yuki-link/issues/125)，仅采用 US04/US05/US06/US26/US32/US33/US35、AC02/AC09/AC13/AC14。
- Fixed point / 已核对 HEAD：`e86d607c695b9832cc1c1627111c0e51726a5468`。
- Worktree：`.local/worktrees/companion-003`；checkpoint：`.local/workflow-state/COMPANION-003.md`。
- 上游来源：AAAAGENT / phoiex 及贡献者，固定提交 `2752349bcc7f7137b8b9e4ff9cccf34026d77aad`。下文上游路径均绑定此提交，不代表 latest。
- 2026-09-25 fresh design；Owner 指定 `gpt-6-astra high`。没有读取旧 Codex session/history，没有复用被中止设计。设计未运行产品测试、真实服务或设备验收。
- **状态：The current ticket is ready for implementation.** Owner/Orchestrator 已依据已验收 COMPANION-014 解决 reasoning 边界，当前无必须 Owner 决策或设计 blocker。外部资源与真实调用授权仍是对应使用/验收 gate，不阻塞代码实现；AC02 尚未验收。已由本轮要求确定的约束标为“既定”；其余技术选择为实现建议 **Proposal**，不新增审批 gate。只交付本地 Notes，不同步 GitHub。

## Implementation Decisions

### 1. 当前事实与单一运行组合

**事实：**当前 Yuki 没有 ASR、TTS、capture、playback 或 Live2D 实现；`BackendSession.runtimeCapabilities()` 的 `voice/live2d` 均为 false。`THIRD_PARTY_NOTICES.md` 明确未复制上游语音/Live2D 代码或资产。#128 的“复用现有管线”应落实为裁剪适配 pinned upstream，不能声称本地只差打开开关。

当前可复用事实入口：

| 入口 | 当前行为及本票影响 |
| --- | --- |
| `tools/companion-desktop/desktop/electron/main.mjs`、`preload.cjs`、`transport.mjs` | 一个 BrowserWindow、sandbox/contextIsolation、受信主 frame IPC、一个 utilityProcess。连接 generation 只处理后端替换，尚无逐回合取消。 |
| `tools/companion-desktop/desktop/renderer.js` | 本地 `busy/pendingGeneration`；reply/error 尚未按 pending request id 严格关联。`记住：` 与模糊 Memory 请求在 submit 前分流。不能只复用 worker.submit 而漏掉此语义。 |
| `tools/companion-desktop/backend/session.mjs` | 校验输入、provider、busy；每次 submit 召回有效 Memory 并产生真实 runtime 快照；finally 无条件释放 busy，尚无 AbortController。 |
| `tools/companion-desktop/backend/dialogue-pipeline.mjs` | Composer → provider → 完整回复校验 → 同步 SQLite 事务提交 user/assistant 两行 → 返回。provider 失败不写回合；本地提交失败与远端失败分开。 |
| `tools/companion-desktop/backend/provider.mjs` | 已有 DeepSeek 非流式调用，Thinking off 60s / on 300s deadline；没有调用者取消 signal。 |
| `tools/companion-desktop/backend/sqlite-memory.mjs` | `history()` 仅 role/text 且遵守 Memory cutoff；`displayHistory()` 包含已存 reasoning。不能绕开 cutoff 或另建语音 history。 |
| `tools/companion-desktop/desktop/electron/settings-store.mjs`、`submit-snapshot.mjs` | 串行原子保存；main 接受 submit 时冻结已提交 Role Card/Thinking。 |

**既定：**继续使用这个 Yuki Link Desktop，不启动第二 app、第二陪伴后端、AAAAGENT launcher 或 DSH。

**Proposal：**用三个有明确职责的 module 补能力：renderer 的 `VoiceDevices` 负责设备生命周期；main 的 `VoiceTurnCoordinator` 负责当前语音意图、IPC/配置快照和取消协调；同一 utilityProcess 内的 voice adapters 负责 ASR/TTS。`BackendSession` 仍是模型回合及 SQLite 提交的唯一 owner。模块可拆文件，不建立新的通用编排框架。

```text
用户明确按下语音入口
  → renderer VoiceDevices：麦克风 → 单声道 PCM WAV
  → preload 白名单 → main VoiceTurnCoordinator → 现有 utilityProcess ASR
  → 最终 transcript → renderer 同一个 dispatchUserText
  → main submittedTurn（已提交 Role Card / Thinking 快照）
  → worker → BackendSession → DialoguePipeline → DeepSeek → SQLite commit
  → 已提交 final assistant text → 同一 worker TTS
  → main → renderer BrowserPlaybackDriver → 实际输出设备
  → 本地 playback amplitude → Cubism adapter 的 mouth 参数
```

### 2. 统一文本、Thinking、Memory 与历史

**Proposal：**抽取现有 renderer submit 处理为同一个 `dispatchUserText(text, origin)`；typed form 与经 scope 校验的 ASR final 均调用它。保留现有 Memory 意图分流与“保存成功才显示成功”的规则；普通文本最终只调用 `BackendSession.submit` 一次。语音中的模糊 Memory 请求打开同一管理 UI，不偷偷生成模型回复；确定的 `记住：` 走同一显式本地记忆操作，本票不为其补造 assistant/TTS 历史。

- ASR 只接受一个完整最终 transcript；归一化仅 LF、trim 与统一输入校验（非空、≤20000 字符、拒绝 NUL）。不调用另一模型修正、翻译、补标点或提取指令；ASR annotations 不进入 prompt/Memory。归一化 helper 对 typed/voice 一致。
- 识别文字显示为“已识别、待提交/处理中”的临时文本；普通语音默认自动进入同一个 submit，不覆盖正在编辑的 typed 草稿。只有 SQLite 成功提交后才成为历史两行。失败保留可复制/编辑的 transcript，重试由用户发起，不自动重跑模型。
- Role Card/Thinking 在**最终文本被 main 接受为 submit 时**取 committed snapshot，不在按下录音时提前冻结。ASR 期间设置保存影响随后提交；模型运行中保存不改变该轮。Thinking 保存 pending 时，语音 final 与 typed 一样等待确定结果；不绕过已有 gate。
- recall、Core → Role Card → Runtime → Memory → Recent Conversation → 当前 user 的组合仍在原 Session/Composer。Recent history 继续遵守有效 Memory cutoff；不另建 voice session ID、prompt 或 conversation.sqlite。
- **既定 — reasoning 边界（原 O1 已解决）：**Owner/Orchestrator 已依据已验收 COMPANION-014 确认：保留现有文字链 assistant `reasoningContent` 的本地 SQLite 持久化、256KiB 截断和重开查看语义；语音识别文本进入同一文字链，沿用该语义。#128 不删除、迁移或清理既有 reasoning 历史。
- 新增 voice/media 链不得把 `reasoningContent` 送给 TTS、ASR、playback、Live2D、Memory 或下一轮 prompt；不得新增第二份 reasoning 持久化、日志或媒体映射。TTS 仅接受已经成功提交的 `assistant.text`（final assistant content 的已有 trim 结果），不得接收整个 reply/messages、Role Card、Memory 或工具日志。原 O1 不再是 Owner Decision。
- TTS/扬声器失败不回滚已提交文字；状态为“文字已回复，语音未完成”。不把 ASR 完成、TTS 返回 URL 或 source.start() 当作可听见的成功。

### 3. Capture、音频传递和上限

**Proposal：**第一版使用窗口内“开始录音 / 停止录音并发送 / 取消本轮”按钮，避免全局热键与常驻监听。停止录音是 finish，取消是 discard。新一轮录音先停止当前输出，采用半双工，避免把 Emilia 自己的回复录进去；不做唤醒词/VAD 自动提交。

- capture 位于 renderer，用 `getUserMedia({audio: ..., video:false})`、AudioWorklet 和显式所选 microphone。删除上游 `startCamera`、TemporalFrames、JPEG、视觉感知所有路径。idle、打开 Settings、文字输入均不得获取 microphone track。
- 点击时准备并 resume 音频上下文；permission pending 可取消。迟到的 getUserMedia 成功必须立即停止其 tracks，不进入图。仅在 track、worklet、context 和第一块 PCM 均就绪后显示 listening；第一块可为零，不能假称已检测到人声。
- 捕获保留实际 AudioContext sampleRate，不把 48k PCM 标成 16k。第一版接受 8–48kHz、mono、PCM16 WAV；不支持的设备采样率报明确错误，不隐式安装转码器。finish 先停 track，再 drain 已捕获 worklet 数据，编码 WAV；flush deadline 2s，失败丢弃并清理。permission/初始化等待上限 30s。
- 单次最多 30s；Float32 总样本上限 1,440,000，WAV ≤3MiB。达到限制停止采集并报“录音超限，请缩短重录”，不默默截断上传。main、worker 再独立校验实际字节数、WAV header/RIFF 长度、channels/bits/rate/duration，不能信任 renderer 元数据。
- 沿已有 IPC 发送一次有界 `Uint8Array`（不是 Base64 跨 IPC、不是文件路径）；每条命令带 `schemaVersion=1, connectionGeneration, voiceTurnId, voiceEpoch, requestId`。main 分配 voiceTurnId/epoch，renderer 发起意图 ID 仅用于关联。`finish` 每轮只接受一次，重复/旧轮次消息释放 bytes，不重复 ASR。
- 现有 ipcRenderer.send / utilityProcess.postMessage 使用 structured clone；不宣称跨三层零拷贝。发送方在完成本层拷贝后清零自己拥有的数组并释放引用；接收方在消费、失败或 stale 时同样清理。AudioWorklet 的内部 transfer 可沿用，不能假定 contextBridge transfer list 可直接透传。
- ASR 输入在 request 构造后释放 PCM；Base64/JSON 字符串无法可靠原地覆写，尽早释放引用，不记日志/缓存。playback 的 AudioBuffer 各声道在停止后清零，disconnect source/analyser、清 timer、关闭 port/context。JS/浏览器内部拷贝只能尽力释放，不承诺物理内存绝对擦除。
- **不使用音频临时文件。**原始音频、TTS WAV 仅在有界内存流转，无 raw audio SQLite、磁盘缓存、Blob URL 或共享临时目录。未来若 adapter 必须落临时文件，需重新设计受限 userData 子目录/Windows DACL/生命周期，本票不得临时加无管控落盘。

### 4. Provider adapter contract

**Proposal：**首个可实现组合为 pinned `QwenAsrProvider` + `QwenTtsProvider`，仅官方系统 voice；不一次实现三套 TTS。接口分别是 `transcribe({scope,wav}, signal) -> {text, safeUsage}`、`synthesize({scope,finalText,voiceConfig}, signal) -> {wav,durationMs,safeUsage}`。生产与 injected fake 共用接口；preview 不自动切到真实媒体调用。

| 项目 | 约束 |
| --- | --- |
| ASR 请求 | 固定 `qwen-audio-3.0-asr-flash`；北京区 POST `/api/v1/services/aigc/multimodal-generation/generation`，使用 `input.messages[].content[].input_audio` Data URL、`parameters.format=wav`、真实 sample rate，并以 `X-DashScope-SSE: disable` 请求非流式 final result。只接受 `output.text` 且 `output.sentence.sentence_end=true`。不加 system/history，不自动 retry，不静默换 latest。 |
| ASR 响应 | choices 恰好一项、finish_reason=stop、content string；空白为 `NO_SPEECH`，不调用 DeepSeek。不将可选 emotion/language 当必需成功条件。 |
| TTS 请求 | 固定 `qwen-audio-3.0-tts-flash`；北京区 POST `/api/v1/services/audio/tts/SpeechSynthesizer`；`input.text`、受支持系统 voice、`format=wav`、`sample_rate=24000`，并可用单条 `instruction` 控制自然中性表达。当前允许 `longanfengyue` / `longanlingxi` / `longanyuanfei`，默认 `longanfengyue`。非流式响应只接受 `finish_reason=stop` + 受信 OSS 音频 URL；不自动 retry。 |
| 长回复 | 沿用 `splitSpeech`，每段 ≤600 Unicode 字符，拼接后等于完整 final text；串行最多 10 段/6000 字符、总音频 ≤120s/16MiB。超限在发起 TTS 前拒绝并保留文字；不朗读截断部分却显示“已读完”。当前先全部合成校验后播放一次，不做流式逐句播放。 |
| TTS 响应/下载 | 校验业务成功与 output.finish_reason=stop、合法 audio URL、完整 PCM WAV；加上上游缺少的 body/下载字节流上限及完整性检查。JSON ≤1MiB，读取时累计限额，不只信 Content-Length。所有片段格式一致才合并。 |
| 网络目的地 | Settings 选择已评审 provider/region/profile，main 生成固定 HTTPS endpoint；不接受任意 URL。兼容旧官方域名不等于自动选择区域。音频下载仅允许该 profile 已评审的官方 OSS 主机，拒绝私网/loopback/IP literal、userinfo、非默认端口、redirect；不附 Authorization。保留合法签名 path/query 原字节；仅对上游精确匹配的官方 HTTP OSS 地址升级 HTTPS，无 HTTP fallback。 |
| timeout | ASR 总计 45s；TTS 每次请求+下载 45s、整轮合成 120s；覆盖 body read/decode 前置校验，不只等 headers。调用者 abort 与 deadline 合并，区分取消/超时。DeepSeek 继续现有 60s/300s，并新增同一回合 signal。 |
| errors | 受控 `{stage,code,retryable,httpStatus?,requestId?}`：UNCONFIGURED、AUTH(401/403)、RATE_LIMIT(429)、NETWORK、TIMEOUT、PROVIDER_FAILED、INVALID_RESPONSE、NO_SPEECH、AUDIO_LIMIT、CANCELLED；设备另有 PERMISSION_DENIED、DEVICE_MISSING/BUSY、CAPTURE_FAILED、PLAYBACK_BLOCKED/FAILED。禁止原始 body/error cause/签名 URL/credential 出现在 UI 或日志。 |
| retries | 本票无自动付费重试、provider fallback 或模型重试。用户重新录音才重做 ASR；已提交文字的 TTS 重试只重做该 reply 的 TTS，明确一次新的调用，不重复 DeepSeek/历史。 |

当前官方文档核对：Qwen-ASR 支持兼容模式与 inline audio，旧域名仍可用、区域凭据不同；型号可用性仍需对应账号确认，见 [ASR API](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference)。TTS 的每次 600 字符和 instruction 参数、最终音频 URL 见 [TTS API](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api)。这两项文档核对不代表本机服务 ready。

## Upstream Reuse Matrix

所有路径相对于 pinned `windows/code/desktop-pet/`；[固定版本源码入口](https://github.com/phoiex/AAAAGENT/tree/2752349bcc7f7137b8b9e4ff9cccf34026d77aad/windows/code/desktop-pet)。Reuse 表示算法可原样保留（允许 TS → 本项目 ESM 与 import 调整）；Adapt 表示存在必须修改的行为；Reference-only 不纳入本票运行组合；Do-not-copy 表示本票禁止引入。

| 上游模块 | 分类 | 原因 / 适配与许可边界 |
| --- | --- | --- |
| `media/wav.ts` 的 `pcm16Wav`；`providers/qwen-tts.ts` 的 `splitSpeech` | Reuse | 纯 PCM 编码及无损分段可保留；调用前加本票限额，WAV inspector 另补严格 header/大小校验。保留来源及非商业署名许可。 |
| `providers/qwen-asr.ts` | Adapt | 保留只上传音频、严格 final transcript；MediaStore/TurnScope 换成本票内存/scope；去 emotion import，增加限额、deadline、受控错误。 |
| `providers/qwen-tts.ts` | Adapt | 系统 voice 最短接入；保留分段/HTTPS 升级思路，移除 expression 协议依赖，补 finish_reason、下载主机和字节上限、取消后 joined buffer 清理。 |
| `media/browser-capture.ts`、`media/recorder-worklet.mjs` | Adapt | **上游 open 在 audio_ready 后调用 startCamera**；必须删除 camera/JPEG/frames 路径。增加设备选择、deadline、worklet 丢弃/清理与有界 flush。不能整块复用。 |
| `media/browser-playback.ts`、`desktop/playback-controller.ts` | Adapt | 保留 actual output timestamp、RMS、单一输出 owner、迟到 open 清理与重复包不重播；新增 sink 选择、播放 watchdog、AudioBuffer 清理，scope 换成本票标识。 |
| `media/scope.ts`、`desktop/view-state.ts` | Adapt | 借用 abortable 与 scope/current 检查、只有 playback started 才 speaking；不复制角色注册、invitation、presentation/第二 runtime。abort race 后的资源仍由 owner 清理。 |
| `desktop/press-to-talk.ts` | Reference-only | hold/release 与 permission pending 可取消原则可参考；第一版窗口按钮足够，不接全局按键/native hook。 |
| `providers/qwen-audio-tts.ts` | Reference-only | 固定模型/voice binding、精确 streaming WAV header 修补属于另一服务协议；不混入首个 Qwen3 adapter，不普遍“修复”损坏 WAV。 |
| `providers/minimax-tts.ts`、`providers/registered-voices.ts` | Reference-only | 此 adapter 依赖已注册音色 binding，并带一次特定 HTTP 重试；不假定现有账号/音色可用，也不复制注册表或自动重试策略。 |
| `management/voice-setup.ts`、`management/voice-reference-store.ts` | Do-not-copy | 前者含 cloning/activating/注册和费用状态，后者持久化参考音频并涉及 probe；训练/克隆/注册均超范围。也不复制任何用户音频。 |
| `core/work-speech.ts` | Reference-only | “新输入废弃未播通知”的 epoch 原理有用；工程播报、task binding、Codex/Harness 路由不进入本票。 |
| `desktop/cubism-renderer.mjs` | Adapt（局部） | 保留官方 Cubism load/model/WebGL/texture/dispose seam；原文件静态 import Framework TS、特定 presets/parameterMap，强制 Physics/Idle/表情，并使用固定 `ParamMouthOpenY` 和角色开关。移除这些要求，改成合法本地模型+明确 mouth mapping；不重写 Cubism deformation/runtime。 |
| `desktop/interaction-motion.mjs`、`model-feather.mjs`、presentation presets | Reference-only | 本票不需要动作/表情/羽化/外观系统；不为静态显示+mouth 引入整套依赖。 |
| `tests/providers/{qwen-asr,tts-download}.test.ts`、`tests/desktop/playback-controller.test.ts`、`tests/media/capture-parallel.test.ts`、`tests/integration/{desktop-runtime,voice-reliability}.test.ts` | Adapt / Reference-only | 改写适用断言为 Yuki 最高有效 seam 的小测试；不继承上游摄像头、自动朗读 typed text、自动 TTS retry 或旧 pipeline 的历史语义，不搬整个 fixture 图。 |
| Cubism Core/Framework/shaders、第三方模型/纹理/动作/表情/音色/截图 | Do-not-copy（未经独立授权） | AAAAGENT 不包含现用模型和 SDK，其许可也不授予第三方权利。只按下述本地资源合约由用户提供；未经确认不 commit/package。 |

`windows/docs/LIVE2D.md` 已定向读取：上游仅支持 model3/moc3，明确独立 SDK/资源授权及模型特定假设。上表结论来自实际 renderer、capture、playback、providers 及直接必要 imports，不来自上游测试数量。

## Voice State Machine / cancellation

**Proposal：**区分四类 ID：transport `connectionGeneration`（worker 生命周期）、main `voiceTurnId + voiceEpoch`（语音意图）、Session `requestId + model token`（模型 owner）、SQLite `turnId/messageId`（已提交历史）。不复用一个 generation 兼任这些身份。所有回包/音频/播放事件带所属 scope；取消 epoch 只能由可信 main 推进。

| 状态 | 进入证据 | 合法下一步 / committed truth |
| --- | --- | --- |
| idle | 没有活跃 voice owner；mouth=闭口值 | 明确 start → preparing；typed 正常可用。 |
| preparing | main 已接受意图，设备/permission pending | capture ready → listening；取消/超时/设备失败 → cancelled/error。没有历史。 |
| listening | 当前 scope 的真实 track、运行 context 和 PCM 已到达 | finish → transcribing；cancel 丢音频；新 start 先取消旧轮。 |
| transcribing | track 已停止、WAV 校验通过、ASR 请求开始 | final → 同一 text dispatcher；Memory 分流可回 idle；普通 submit 被 Session 接受 → thinking。 |
| thinking | Session 已接受普通文本，busy 由其 active model token 持有 | commit → synthesizing；cancel 在 commit 前可阻断写入；失败 → error。临时 transcript 不是历史。 |
| synthesizing | user/assistant 事务已成功提交，TTS 正在进行 | 有效 WAV → playback-pending；停止声音/取消 → cancelled（文字保留）；TTS 失败 → error（文字保留）。 |
| playback-pending | 正在解码、选设备、resume 或等待输出帧 | 真实 started → speaking；cancel/error 均不得显示“已播放”。 |
| speaking | 当前 output session 报告 started | RMS 驱动 mouth；ended → idle；stop/cancel/error 立即闭口。 |
| cancelling | 已本地停止设备并送出取消，但 Session 提交边界尚未核实 | matching ack 确定 cancelled 或 alreadyCommitted；断连显示结果未知，重连读取历史。 |
| cancelled / error | 对应作用域已失效；清理完成或有明确失败事实 | 保留原因/文字提交状态；下一次明确输入可回 idle/preparing，不自动重新调用。 |

### 控制动作及竞态提交点

- **停止录音并发送：**只 finish capture，允许该轮 ASR → submit → TTS 继续；不等于 cancel。
- **取消本轮语音：**停止当前 capture、ASR、该语音所属 model（若仍未提交）、TTS 和播放。已经提交的 user/assistant 不删除；已经成功提交的 Memory 操作也不撤销。
- **停止声音：**取消当前 TTS 或停止当前 playback，设置该 output token 不再可播；保留模型及已提交文字，不发 cancel-model。在 thinking 阶段此按钮不可误当取消回复。
- **取消当前模型回复：**针对当前 requestId，由 Session 取消 typed 或 voice 的模型回合；若属于 voice 同时禁止该轮未来 TTS。已提交则返回 alreadyCommitted，不谎称撤回回复。
- 以上命令都不得引用 engineering card/task ID、调用 Engineering Workbench/YCA/DSH stop 或修改工程状态。普通聊天文本中的“停止任务”也不在本票解析成工程控制。

**Backend committed truth：**Session 新增 active request/controller；`submit` 向 DialoguePipeline/provider 传入 signal 与 `isCurrent`。每个 await 之后、provider 状态回调之前、**同步 appendTurn 之前**检查 token。最后检查与同步 SQLite transaction 之间不能插入 await。取消命令与 commit 在 worker 事件循环中的处理顺序决定结果：先处理 cancel 就不写；先 commit 就保留并在 ack 中明确 committed IDs。UI 点击时间不能伪造数据库回滚。

- abort 使用真实 fetch signal + abortable wait。第三方忽略 abort 时可释放本地等待，但后台迟到 Promise 必须被观察且只能丢弃/清理；不能再修改 requestState、history、voice 或下一轮 busy。`finally` 只有仍持有同一 active token 才能释放 busy；busy 拒绝/主动取消不假记远端失效。
- main 协调器只串行执行短状态转换，不能 await 一整条 ASR/model/TTS 才处理 cancel。new voice start 先本地 stop capture/playback/闭口、推进 epoch、请求取消当前模型（包括未完成 typed reply）；拿到旧模型 ack 和旧设备 cleanup 后才开始新 capture。失败/失联时不启动另一个模型来绕过旧 owner。
- typed send 在 listening/transcribing 时先取消当前 voice，然后提交 typed；thinking 期间仍遵守已有 busy，用户可显式取消后再发。TTS/speaking 时 typed send 停旧声音后正常 submit。语音入口在 model busy 时仍可用于“重新说话”，不能被通用 renderer busy 永久禁用。
- renderer 增加 pendingRequestId，与 generation、origin、voice scope 匹配才清 busy/草稿。`reply/error`、`ready/disconnected`、`cancel-ack` 分开；旧 reply/error 不清新草稿、不重开旧 TTS、不恢复旧 mouth。
- **历史与输出分开投影：**先 commit 后 cancel 的合法旧回复仍可按 messageId 去重加入历史/通过 ack 或 history refresh 恢复，但不更改当前 voice 状态、不清新草稿。旧轮未提交的 late reply 则根本不能到 appendTurn；仅在 renderer ignore 不足以满足此条件。
- duplicate finish、submit-after-ASR、TTS/play delivery 用 scope/requestId 与单次消费状态去重。取消 ack 有限等待（建议 2s）；超时显示“已停本地设备，回复取消结果待核实”，禁用依赖该未知 owner 的新语音；不声称远端已停止计费，也不自动重发。
- close/restart：main 立即失效所有 voice scope 并要求 renderer teardown；worker close 先 abort/invalidate Session，再关 DB，禁止关库后 late append。transport.close 在开始关闭时失效旧 generation/忽略旧 message，不等新 start 才挡晚包；保留已有 1500ms 子进程退出兜底，仅用于本 app worker，不触及工程任务。

## Live2D Resource Contract

**Proposal：**普通聊天窗口内增加一个可折叠 canvas；默认无模型时显示缺项说明。最低成功是合法 model3/moc3 实际 WebGL 绘制 + 实际播音时可观察嘴部变化，不要求 idle motion、physics、表情、眨眼、眼神、换装或热切换。

### 本地模型

- main 系统文件选择器选择用户自备目录中的 `.model3.json`；renderer 不提交任意绝对路径。只引用资源，不把用户原件复制进仓库或发布目录，也不自动下载/解压。先做候选校验，再通过 SettingsStore 提交 `Live2DConfigV1`。
- 配置包含 opaque resourceId、可信 main 内的 canonical modelRoot/entry、模型文件 fingerprint、可显示的来源/许可说明、`mouth:{parameterId,closed,open,gain}`、SDK binding。renderer 只收到显示名、opaque ID、readiness、参数映射；不收到私人绝对路径。
- 最小必需集合：入口 JSON、一个 `.moc3`、非空 `.png` Textures。模型 JSON ≤1MiB、moc ≤64MiB、≤32 张纹理、整个引用集合 ≤256MiB；纹理解码前后有像素/内存上限（总 RGBA ≤256MiB）且不得超过当前 GPU MAX_TEXTURE_SIZE。限额是本地资源预算，不是 SDK 能力承诺。
- Yuki validation safety policy：`FileReferences` 中所有声明的文件路径项（Moc、Textures、Physics、Pose、UserData、DisplayInfo、Expressions、Motions 等）总声明数 ≤256，作为读取引用文件前的 hard limit；重复声明同一路径也逐项计数。可另计算 unique canonical file set，但不能用去重后的数量替代声明数；上述纹理数量、JSON/moc/总大小预算同时执行。这是 Yuki 自己的安全策略，不是 Cubism 官方能力限制。
- 所有 FileReferences 包括声明了但本票不播放的 Physics/Expressions/Motions/Pose/UserData/DisplayInfo 都须做结构、后缀、存在性与安全路径检查；未声明的可选项不强制存在，不加载其动作。未知引用类型或缺失引用明确报错，不忽略后宣称完整。
- 拒绝 URL、UNC/网络共享、绝对路径、盘符/ADS、NUL、反斜线、`.`/`..`、编码绕过、symlink/junction/reparse escape、非普通文件。解析后必须仍在所选 canonical root 下；读取时核对 handle/stat/realpath 与限额。只开放 validated manifest 中的具体文件，绝不把所选整个目录暴露给 renderer。
- fingerprint 覆盖 entry、moc、**纹理**及全部声明引用的 path+SHA256；不能照搬上游不含纹理的 presets fingerprint。每次加载/重新启用校验文件变化，每次资源响应验证实际读取 bytes；变化使旧 binding/readiness 失效，要求重新选择/确认，不继续信任一次探测。
- SDK 真加载后核对 moc 兼容性、drawables、纹理解码、实际 parameter ID 与 min/max；`closed/open` 均须在范围内且不同，gain 有界。可从模型 LipSync group 的单一有效参数提出默认映射；缺失/多义时显示需要选择实际 mouth 参数，不假定所有模型都有 ParamMouthOpenY，不修改隐藏部件/水印。
- Yuki adapter safety policy：`mouth.gain` 默认 `1.9`（适配起点来自 pinned AAAAGENT renderer 的 `Math.min(1, Math.sqrt(view.mouth) * 1.9)`），合法值必须 finite 且 `0 < gain <= 4`。这不是 Cubism 官方能力限制或模型 parameter range；实际 SDK/model 加载后仍须校验 `closed/open` 在真实 parameter min/max 内且 `closed != open`。映射保持 `closed + clamp(gain * sqrt(rms), 0, 1) * (open - closed)`。
- resource revoke/disable：保存成功后失效 resourceId、dispose canvas/GPU/口型；新请求拒绝旧 ID。保存失败保留旧 committed 配置；若旧资源本身已经无效，旧配置仍在但 readiness=false。撤销不删除用户原件。换模型走明确卸载→校验→重新加载，不追求无缝热切换。

### SDK 与 packaged 路径

- 上游 `cubism-renderer.mjs` 直接 import `vendor/cubism/Framework/src/*.ts`，依赖编译后的 Framework、Core 与 WebGL shaders；把源目录填进 Settings **不能**使当前无 bundler 的 Yuki renderer 自动运行。
- 首版支持一个经过核对的 Cubism Web SDK 组合（以上游 `Cubism5-r.5` 适配为起点；精确版本/文件 hash 在资源提供后固定）。本地 SDK contract 必须明确 Core、Framework、shaders 版本一致、来源、许可、内容 hashes、Yuki adapter API version，缺一项不能 modelReady。
- Phase C 使用项目提供的确定性、无网络 preparation/build helper，将 Owner 自备且版本/hash 校验通过的官方 Framework 编译为浏览器 ESM，并准备 Core/shaders；输出到被忽略的本地资源目录，不到 `desktop/**/*` 发布 glob。可增加唯一必要的锁版本开发 bundler；不在运行时要求系统 Node/npm/TypeScript，也不下载 SDK。
- package 只含 Yuki adapter、资源校验/加载代码及许可声明。Settings 选择已准备的 SDK resource pack；缺 SDK 时不执行静态 import，文字/语音仍可启动。供应 SDK 的准备步骤是独立 external gate，不能把“缺 SDK 跳过构建”报为实际 Cubism 验证。
- 资源包不是任意 JS 插件：只允许已评审 SDK 文件清单与本地可信 helper 生成的固定格式 artifact；未知 JS、entrypoint、preload、HTML、扩展插件拒绝。生成 manifest/hash 用于完整性；**自带 manifest 不证明来源可信**，SDK 原始来源/hash 的核对在执行其代码前完成。
- 继续同一 `yuki` 私有协议、同一 Electron partition，新增互相独立的 app/model/SDK allowlist 路由，opaque revision 防止旧 URL 复用。补 `.mjs/.json/.png/.moc3/.wasm/必要 shader` MIME；不将任意 model 资源当 script 执行。只给已核对 SDK 所需 CSP 权限（若确需 WASM 则限定 `wasm-unsafe-eval`），不启用 `unsafe-eval`、bypassCSP、nodeIntegration 或远程脚本。
- code readiness（本地 adapter/validator 已实现）、packaged wiring（缺资源路径/模块可达）、SDK load/model draw（资源及 WebGL 成功）、实机 talking 分别记录。任一层未运行均是 pending。

### Mouth 最小 seam

renderer playback 的当前 output analyser 产生 RMS（约 20–60Hz），同一 renderer 内传给 `setMouthLevel(scope,level)`；不经 provider、不需要高频 IPC。只有 matching playback started 后允许非闭口值，按模型合法范围映射 `closed + clamp(gain * sqrt(rms),0,1) * (open-closed)`。这是测量振幅映射，不是按字数/定时器随机张嘴。

每帧先恢复必要基线，再设 mouth，最后 Cubism update/draw；本票不加表情或物理覆盖口型。ended/stopped/error/cancel、模型撤销、WebGL context loss 一律闭口并使相应 readiness 失效。SDK 加载失败只降级 avatar，不能停止文字/语音。若上游 controller 不能安全剥离，最小替代是自己的 `load / setMouthLevel / reset / dispose` adapter 调用官方 Cubism；不能用 GIF/假的嘴型代替 AC02。

## Settings / readiness model

**Proposal：**沿用 SettingsStore 串行候选→写临时 settings→sync/rename→发布 committed snapshot。增加有版本的 `voice`、`live2d` 字段及专用 load/save/disable 命令；保存需保留 Role Card、Thinking、workbenchUrl。保存成功不等于资源加载成功，分开反馈 configured 与 readiness。

- ASR/TTS 展示 provider、区域、明确 model、系统 voice/speaker、credentialConfigured、最近请求事实、缺项原因。默认 disabled/unconfigured；不自动探测收费接口。
- microphone/output 展示“系统默认”或具体选择。enumerateDevices/devicechange 只更新本机设备投影，不为显示设备名暗自开麦；授权前标签可为 unknown。明确选择消失时报 missing，不静默改到另一麦克风/扬声器。用户显式选择系统默认才跟随系统变更。
- 通过 AudioContext.setSinkId 选择输出（feature detect）；不支持时只提供“系统默认，不能指定输出”。拒绝 `sinkId:{type:'none'}` 充当真实播放。resume 被自动播放策略阻挡时提供“点击播放”；不改 Chromium 全局 autoplay policy 绕过。见 [Web Audio 输出选择](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId)。
- microphone 权限 handler 安装在当前 `persist:yuki-desktop` session，check 与 request 都限制到受信 main frame、正确 URL、当前明确 capture 意图和 audio-only。拒绝 video、空/unknown mediaTypes、display capture；Electron 44 中不能套用 45 对 screen capture 的新分类。输出权限单独按真实 API 能力处理，不能为此自动开麦。依据 [Electron 44 session](https://github.com/electron/electron/blob/v44.4.1/docs/api/session.md) 与 [权限请求字段](https://github.com/electron/electron/blob/v44.4.1/docs/api/structures/media-access-permission-request.md)。
- Key 通过 main 原生文件选择入口导入独立 `voice-credential.bin`，safeStorage 加密；不复用/读取 DeepSeek Key 充当语音 Key，不放进 settings.json。Windows 使用产品数据目录的用户受限 DACL 并验证，不能将 mode=0600 当作 Windows ACL 证据。加密/受限存储不可用则拒绝保存。renderer 只能收到配置/错误事实，key 只 main 解密并送同一 worker，替换时失效 voice provider revision；不泄露 key/credential 文件路径。
- ASR/TTS credential/provider/device 配置替换或禁用，先使当前 voice epoch/output 失效并清理；不重启整套 text worker 来保存 voice settings。Role Card/Thinking 保存仍遵循原逐轮快照；不取消正在运行的模型。

readiness 是**当前事实集合**，不持久化“成功 boolean”：

| 事实 | source of truth | 刷新 / 失效 |
| --- | --- | --- |
| implemented | 当前 package 装配及可调用 module | app build/restart；缺实际 adapter 时 false |
| configured | main committed settings + 可解密 credential 是否存在 | 保存/清除/配置 revision；不是 provider 验证 |
| devicePermission | 当前 renderer/session 的请求结果：unknown/prompt/granted/denied | 新 renderer、OS/设备错误或下一次显式使用重新检查；不从磁盘继承 granted |
| providerReady | 每个 provider 独立 `unconfigured/configured/verified/unknown` + configRevision/checkedAt | 最后真实请求成功才 verified；失败 unknown/auth-error，替换/重启不继承 verified，无后台健康轮询 |
| captureReady | 当前设备/Worklet 支持及当次 capture 初始化 | devicechange、track ended、capture 错误/renderer 退出 |
| playbackReady | API 支持、有效选择、最近当前 session 输出事实；unknown/ready/blocked/error | sinkchange/devicechange/context 错误；每次 play 重新校验，不推断人耳可听 |
| sdkReady/modelReady | main 文件 validation revision + renderer SDK init/真实 draw ack | 文件变化、重新加载、revoke、GPU context loss/renderer restart |
| talkingReady | 已加载模型有效 mouth mapping + 实际 playback signal wiring | model revision、mapping、输出 owner 改变 |

保留 `runtimeCapabilities().voice/live2d` 作为兼容的聚合 boolean，旁增结构化 `mediaReadiness`。worker 只从 main 发送的当前 generation/configRevision 的已验证快照组合，不接受 renderer 任意覆盖 capabilities。main 校验设备/渲染事件的 scope 和 revision；只传状态/原因/时间，不把设备名、私有路径或 Key 写入 prompt。

`voice=true` 仅在真实装配、配置、已授予麦克风权限、输入/输出就绪、ASR/TTS 最近该配置验证成功且 text real 服务可用时成立；`live2d=true` 仅在 SDK/model 实际加载绘制、合法 mouth mapping 和信号 wiring 已就绪时成立。voice 不要求 Live2D、Live2D 静态显示不要求 ASR。未知保持 false，并列出缺项，不能只显示“未实现”。

初次验证不形成死锁：按钮依据独立 `canAttempt`（实现+有效配置、连接、非已知设备阻碍）允许用户明确发起权限请求/首个真实回合；不能用尚待 verified 的 voice=false 禁止首轮。`canAttempt` 不等于已可用。每次 submit 使用当下有效快照；设备变化后的首轮不得带旧 verified/ready 事实。

## Security / privacy

- **既定：**不读取/导入私人历史，不触碰 DSH、工程历史/记忆或工程任务控制；数据目录沿既有 Desktop scope。原始麦克风音频、ASR raw payload、TTS raw response、签名音频 URL 不写 conversation.sqlite、settings、日志或遥测，不使用持久化 media store。
- 只在用户明确 start 时开麦；取消、窗口关闭、renderer gone、断连、超限或异常都停止 track/context、释放 PCM/播放 bytes。late permissions、decode、fetch response 都必须有 owner 清理；缺 teardown ack 时不假称设备已停止、不再自动开新 capture。
- Settings 导入的凭据、SDK 与模型各有独立明确操作；不自动下载/注册/购买/克隆音色，不扫描任意用户目录，不读取浏览器账号/现存环境 Key 来凑 ready。
- 新增媒体日志只允许 scope 的非敏感关联号、阶段、耗时、调用计数、状态码、已校验 requestId 与白名单数值 usage；未知 usage 记 unknown，不保存 raw usage object、音频、完整文本或 reasoning。调试捕获也不例外。
- **已确认的 reasoning 隔离：**保留 COMPANION-014 的既有 SQLite reasoning、256KiB 截断和重开查看；新增媒体接口完全不接收 reasoning，不另存副本/日志/媒体映射，也不传入 ASR、TTS、playback、Live2D、Memory 或下一轮 prompt。无 reasoning 历史删除、迁移或清理。
- 如复用/改编上游代码，更新 `tools/companion-desktop/THIRD_PARTY_NOTICES.md` 的实际路径、固定提交、作者、具体修改说明，修正“未复制语音/Live2D代码”的过时描述，同时保留“第三方 SDK/模型未随包提供”的事实。保留完整 `desktop/AAAAGENT-LICENSE.txt`、文件来源注释与可见 About/License；独立资源条件显示来源，不公开私有路径。不能把非商业 source-available 内容重新标为 MIT/OSI 开源。
- Cubism Core、Framework 与模型授权分别核对；本地导入不自动免除 SDK 应用使用/发行条件。[Live2D 官方 SDK 下载条款入口](https://www.live2d.com/en/sdk/download/web/) 和 [SDK 使用/发行分类](https://www.live2d.com/en/sdk/license/) 是核对入口；本票不推断“非商业所以一定免费/免审批”，不替 Owner 申请或购买许可。

## Implementation Sequence

**建议同一 #128 内 Phase A/B/C 顺序实现，不另拆 GitHub Ticket。** 三阶段是可审查停止点，不各自宣称 M1 完成；使用 fresh implementation session，阶段 checkpoint 记录实际 delta 与未过 gate，不复制本次聊天。

| 阶段 | 最小交付 | gate / 停止点 |
| --- | --- | --- |
| A：统一回合与取消 | 统一 text dispatcher；Session/provider 取消 token、commit fence、request id/generation 投影；voice lifecycle/IPC 协议和 Settings/readiness 初始事实。确定性 fake 从同一 submit 验证，无真实开麦/付费调用。 | typed Role Card/Thinking/Memory/SQLite 回归及 stale reply 测试通过；保留已确认的 reasoning 持久化与媒体隔离。此时 voice/live2d 仍不能报可用。 |
| B：真实语音装配 | 裁剪 browser capture/worklet、Qwen ASR/TTS、受限凭据、真实 browser playback/输出选择；全链 cleanup/readiness；voice packaged failure/wiring smoke。 | adapter 与设备生命周期定向测试、packaged wiring PASS；真实 provider/设备未授权则该层 pending，可以继续不依赖资源的 C 校验代码。 |
| C：Live2D 与实机验收 | resource contract/validator、SDK preparation 与 optional loading、Cubism 最小显示/mouth adapter、同窗口 canvas；完整许可声明；四层验收记录。 | SDK 源/许可未齐时只做 validator/缺项路径；不能标实际 adapter/模型通过。资源齐后实际构建/加载再进行 Owner 声音+口型闭环。 |

不因为阶段耗时增加自动 provider、并发模型或大 fixture 矩阵。发现资源不兼容，记录明确 gate/失败点；若需要改 provider、重写模型/动作或改变任务控制，回到该决定，不带入邻票。业务实现前仍须 Owner 明确 Implement；本设计 session 不继续编码。

## Deterministic Test Plan

测试的 fake 只作为 code evidence，不证明硬件或供应商可用。优先扩现有测试 seam，新增文件名为 Proposal。

| seam / repo-relative 测试入口 | 必须验证的行为 |
| --- | --- |
| `tools/companion-desktop/test/provider.test.mjs`、拟新增 `voice-provider.test.mjs` | 精确 ASR/TTS body、单次调用、最终文本不含 reasoning/上下文；HTTP/业务失败、坏 JSON/WAV、空识别、分段保真、大小限制；deadline覆盖 body、abort/late result 清理；签名保真且下载不带 Key、无不可信主机/redirect/隐式 retry。 |
| `tools/companion-desktop/test/session.test.mjs` | voice normalized text 与 typed 的 messages/Role Card/Thinking/Memory recall/cutoff 一致；commit 前 cancel 不写两行，commit 后 cancel 保留两行且不 TTS；忽略 abort 的旧 provider 晚回不影响新 busy/status/history；本地存储失败仍区别远端成功。 |
| `tools/companion-desktop/test/renderer.test.mjs`、拟新增 `voice-turn.test.mjs` | 两种输入均经同一 Memory/text dispatcher；重复 ASR final 一次 submit；ID/generation 校验、取消 ack、旧 reply/error 不清新草稿；连接替换/关闭失效；四种停止动作绝不派发工程命令。 |
| 拟新增 `tools/companion-desktop/test/voice-devices.test.mjs` | 显式开麦且 video 永远 false；permission pending cancel 后 late track.stop；worklet flush/超限/失败 cleanup；capture/playback 不重叠；decode/open late cleanup；重复 play 不重播；no started/ended 不能 fake success；setSinkId失败/default/devicechange与 playback watchdog。 |
| `tools/companion-desktop/test/settings-store.test.mjs`、拟新增 `voice-readiness.test.mjs` | 配置保存 rollback/并发不丢已有字段；Key 不回显；配置/设备/worker revision 变化失效；configured/verified/permission/canAttempt 区别，未齐文字仍可用。 |
| 拟新增 `tools/companion-desktop/test/live2d-resources.test.mjs` | model3 正常最小 manifest、无可选 motion 仍可校验；错误类型、坏引用、越界路径/重解析点、缺文件、hash/纹理变更、超预算、未知SDK代码拒绝；revoke 与加载旧 revision race。使用合成路径/JSON fixture，不生成假 moc 声称真实模型通过。 |
| 拟新增 `tools/companion-desktop/test/live2d-mouth.test.mjs` | 真实 renderer adapter 的 injected parameter setter seam：matching started+RMS 才改变参数；范围映射、静音闭口、late amplitude丢弃、ended/cancel/error闭口；不开随机动画，合成 amplitude 只证明函数/连线。 |
| `tools/companion-desktop/test/sqlite-memory.test.mjs`、`tools/companion-desktop/test/prompt-composer.test.mjs` | 保留当前事务/角色顺序、reasoning 的既有持久化/256KiB 截断/重开查看、与 prompt 分离、Memory cutoff、旧数据回看；补 reasoning 不进入媒体链或第二份存储的断言，无数据库清理迁移。 |

packaged smoke 扩展现有 `tools/companion-desktop/test/packaged-smoke.mjs`：仍从 `dist/win-unpacked/Yuki Link Desktop.exe`、隔离 smoke-data、非源码 cwd、无系统 Node 的 PATH 启动及重开；确认 utilityProcess/新增 ESM/worklet MIME/Settings/缺SDK与缺provider提示/取消IPC/文字路径/许可入口。装配 fixture 仅标 synthetic wiring，不模拟麦克风→扬声器成功。合法 SDK 资源缺失时明确记录真实加载子项 SKIP/PENDING，不把该子项计为 PASS。

实现模型只跑红→绿所需定向测试；完整 suite、打包与长日志由既有 Emilia+YCA 确定性层执行并交摘要。当前设计没有运行这些测试，因此没有新 PASS 计数。

## Real Acceptance Plan

分四层记录，同一代表性合成内容回合即可，不新增压力矩阵：

1. **Code deterministic PASS：**上述相关定向测试及必要既有回归，记录 commit、命令、结果。证明代码逻辑，不证明真实模型/设备。
2. **Packaged wiring PASS：**实际 EXE 启动/重开与组件/资源缺失/错误状态，记录产物 hash、版本和各子项；synthetic 文本/音频只可注明 wiring。没有 SDK 时的缺项提示不能替代 SDK 成功加载。
3. **External resource readiness：**Owner 配置的 ASR/TTS provider/区域/型号/voice、独立调用授权、DeepSeek 配置；Windows microphone/output权限与设备；合法模型/SDK 来源与允许的使用范围、精确版本/hash、实际 SDK/model draw/mouth mapping。任一缺项列 pending，不自动下载、购买、读取 secrets 或开麦探测。
4. **Owner 实机闭环：**从已打包 app 明确开始录音，说一句不含私人信息的短句，停止发送；看到真实 ASR transcript、同一 Emilia/角色卡/Thinking/Memory 语义的 DeepSeek final、听到**物理扬声器**的 TTS，同时看到合法 Live2D 实际嘴部随声音变化并在结束/停止时闭口。记录 Owner 确认听到/看见；不能只凭 waveform、文件、decode 或 output timestamp 作证。

在同一有限验收轮次检查一次重新说话/取消动作：本地设备停止且旧轮不恢复；文字已提交时保留历史。若验证“取消模型”必须发生新的真实付费调用，明确计入授权/调用数；没有执行就记该真实子项未验证，不补一套压力测试。Settings 缺资源的降级已在 packaged 层验证，不在实机层重跑大矩阵。

AC 对应：AC02 需要层 3+4 完整证据；任何外部条件未齐就保持 **pending**，不得宣称 M1 complete。AC09 本票仅证明语音/模型控制与工程撤销/停止隔离，跨端工程控制仍属后续票。AC13 通过限定 diff/数据目录、未接工程 API/未导入私人历史以及来源声明检查；不为验收打开私人聊天。AC14 用实际观察记录，不承诺稳定性。

记录最小字段：artifact/commit、日期、provider/model/region（不含账号私密标识）、各 gate 结果；start click、first PCM、capture stop、ASR final、model submit、DB commit/首条可见 final、TTS ready、playback started/ended 的单调时间差；`click→首回复` 和 `停止录音→首回复/首个输出帧` 分开。当前 DeepSeek 非流式，不能报告未测得的 first-token latency。另记 ASR POST、DeepSeek POST、TTS POST（逐段）、音频 GET 计数、失败阶段/码、手动重试、取消后远端计费未知；工程额外模型调用/派发仅在有本轮计数证据时写 0，否则 unknown。人耳听见与设备时钟是两条独立证据。一次通过不是日常长期稳定使用。

## External Gates

| Gate | 最迟需要时点 | 未齐时可继续 / 禁止宣称 |
| --- | --- | --- |
| ASR/TTS provider、区域、精确型号/voice 权限与 Key、真实调用授权 | Phase B 的首次真实调用前 | 可做候选 adapter deterministic/package；不得假称 providerReady 或自行换模型。Owner 若选首版支持集外 provider，须先定向改 adapter 设计。 |
| DeepSeek 已配置及真实对话调用授权 | 真实语音模型往返前 | 不读取已有 Key 来绕授权；preview 不算 DeepSeek。 |
| microphone / physical speaker、权限及 Owner 操作 | 首次真实设备验收前 | 可测 lifecycle fake；不自动开麦或用 synthetic audio冒充听见。 |
| 合法且兼容的模型、实际 mouth parameter | Phase C 实际 model load 前 | 可完成路径/配置校验；static placeholder 不算 Live2D。 |
| 官方 SDK Core/Framework/shaders 的许可、来源、精确版本及 preparation | Phase C 真实 Cubism 编译/加载前 | 可完成 optional loader/缺项 smoke；SDK type/runtime 兼容验证 pending，code readiness 也须注明未编译部分。 |
| SDK/模型在目标用途和发行方式下的独立条件 | 使用相关资源前；任何含 SDK/资产的发行前另行核对 | 本票无发布授权；用户提供资源或不随包分发不等于自动获得全部应用发行权。 |

## Owner Decisions

**现在无必须决策。** 原 O1 已解决并写入 Implementation Decisions，不再阻塞 implementation。

provider/区域/voice 选择、本地凭据及有限真实调用授权，留到首次真实调用前；合法 model/Cubism SDK 的来源、版本与使用条件，留到实际 SDK 编译/加载和实机验收前。它们作为上节 External Gates 保留，不阻塞 code implementation，也不允许缺资源时宣称 AC02 通过。

窗口内按钮、单轮半双工、typed 默认不自动朗读、语音 final 自动进入同一 submit 是最小体验 **Proposal**；不新设产品审批流程。如 Owner 的实际体验偏好不同，在授权 Implement 时只确认对应 delta。其余可由本票/当前代码推导的 seam、取消 fence、许可与 readiness 真值规则不重复向 Owner 提问。

## Context Plan

- **Core：**#128；本 Notes；`AGENTS.md`；固定 HEAD 与 `.local/workflow-state/COMPANION-003.md` 的本轮 checkpoint。fresh implementation 只接引用、阶段/fixed point/delta及必要约束；reasoning 边界以本 Notes 已确认决定为准，不接设计聊天或旧 session。
- **Phase A：**`tools/companion-desktop/backend/session.mjs`、`tools/companion-desktop/backend/dialogue-pipeline.mjs`、`tools/companion-desktop/backend/provider.mjs`、`tools/companion-desktop/backend/worker.mjs`、`tools/companion-desktop/backend/prompt-composer.mjs`、`tools/companion-desktop/backend/sqlite-memory.mjs`；`tools/companion-desktop/desktop/renderer.js`；`tools/companion-desktop/desktop/electron/main.mjs`、`tools/companion-desktop/desktop/electron/preload.cjs`、`tools/companion-desktop/desktop/electron/transport.mjs`、`tools/companion-desktop/desktop/electron/submit-snapshot.mjs`；`tools/companion-desktop/test/session.test.mjs`、`tools/companion-desktop/test/provider.test.mjs`、`tools/companion-desktop/test/renderer.test.mjs`、`tools/companion-desktop/test/sqlite-memory.test.mjs`。
- **Phase B：**`tools/companion-desktop/desktop/electron/settings-store.mjs`、`tools/companion-desktop/desktop/electron/credential.mjs`、`tools/companion-desktop/desktop/electron/assets.mjs`；`tools/companion-desktop/desktop/index.html`、`tools/companion-desktop/desktop/renderer.js`、`tools/companion-desktop/desktop/style.css`；`tools/companion-desktop/test/settings-store.test.mjs`、`tools/companion-desktop/test/packaged-smoke.mjs`；`tools/companion-desktop/package.json`。仅检索 Reuse Matrix 对应上游 capture/playback/Qwen/media 文件和实际直接 imports。
- **Phase C：**`tools/companion-desktop/desktop/electron/assets.mjs`、`tools/companion-desktop/desktop/electron/settings-store.mjs`、`tools/companion-desktop/desktop/electron/main.mjs`；`tools/companion-desktop/desktop/index.html`、`tools/companion-desktop/desktop/renderer.js`；`tools/companion-desktop/package.json`、`tools/companion-desktop/THIRD_PARTY_NOTICES.md`、`tools/companion-desktop/desktop/AAAAGENT-LICENSE.txt`；pinned `windows/docs/LIVE2D.md`、`windows/code/desktop-pet/desktop/cubism-renderer.mjs` 及已核对 SDK 合约。无资源时不要扫用户目录寻找模型。
- **Related：**`docs/implementation-notes/COMPANION-001.md`（单一 Desktop/text-first/packaging）、`docs/implementation-notes/COMPANION-013.md`（Composer、能力真值、Settings committed snapshot）；#125 仅指定 stories/AC。当前 Thinking/Memory 的实现优先于 001/013 写作时尚未实现的历史描述。
- **Retrieval：**关键词 `busy`、`appendTurn`、`reasoning_content`、`pendingGeneration`、`submittedTurn`、`finish_voice`、`startCamera`、`getOutputTimestamp`、`ParamMouthOpenY`；上游必须使用固定 commit raw/API 定向读取，不 clone/扫描全仓库。SDK/供应商 API 的当前文档只解决具体契约变化，不替换 pinned 源码。
- **Expansion triggers：**选了支持集外 provider/SDK；模型必须特殊动作才能显示；SDK 无法合法准备；取消需要工程控制；需要持久化音频或第二 app/runtime。遇到这些先定位到对应决定，不扩到 DSH/微信/工程票。
- **Handoff：**设计只改此 Notes。上层 Emilia+YCA 在本 run 终态更新 checkpoint 的 Notes 引用、ready 状态、阶段 next action 和 `model_usage`；本 session 无 durable usage 读取结果，input/cached/output/run统计均不得自造，无法取得则记 unknown。下次启动前完成既有 0-token 环境 preflight，不重开已中止设计。

## Out of Scope

原创 Live2D 模型/美术生成、完整动作/情绪系统、摄像头/视觉感知、全局热键/唤醒词/常驻监听、流式 ASR/TTS 与自动重试、训练/克隆/注册/购买音色、多 provider 全覆盖、微信、DSH（COMPANION-005）、第二 app/runtime、工程卡撤销/任务停止、私人历史导入、全面 UI 美化、自动下载 SDK/模型、清理既有 reasoning 历史、GitHub 拆票、commit/push/PR/merge/deploy 均不在本次设计执行范围。

## Phase A 本地实现交付（2026-09-25）

- 本阶段经 Owner 单独授权实现并本地提交；上节中的 commit 限制仅描述设计阶段。Phase B/C 尚未实现，#128 AC02 仍 pending。
- typed 与未来 voice-final 使用同一 `normalizeUserText` / renderer dispatcher / `submittedTurn` / Session / Composer / SQLite 链。保留 Role Card、Thinking 保存快照、显式 Memory 分流与 Recent cutoff、reasoning 本地持久化和 reopen 语义。
- Session 持有 requestId、AbortController 与 current token；provider 合并调用者取消和既有 deadline。DialoguePipeline 在同步 SQLite append 前检查 fence；取消先处理则不写历史，忽略 abort 的晚回不能修改新轮 busy/status/history。关闭先失效回合再关库。
- `cancel-model` / `cancel-ack` 贯穿 renderer、main、worker。ack 区分 `cancelled`、`alreadyCommitted`、`notCommitted`、`unknown-request`、`unknown-after-disconnect`；renderer 仅匹配 pending requestId/generation 的结果可释放当前回合，超时/断连不宣称取消成功，不自动 retry。
- 已提交文字保持历史；`mediaText(requestId)` 仅投影 finalText 和身份，取消后不可再获取，不向媒体提供 reasoning。语音生命周期仅定义最小 scope/命令与 deterministic seam，生产 `canAttempt=false`。结构化 `mediaReadiness` 保留配置/provider/device/playback/model 等未知或缺项事实，voice/live2d 聚合值仍为 false。
- `.mjs` 按 JavaScript MIME 提供，沿用 asset traversal/realpath 安全语义。未触碰工程卡撤销或任务停止通道。

验证证据：

- 红→绿：新增取消前不提交、提交后保留历史/禁止下游、provider signal、归一化、renderer 旧回包与 voice-final、worker/transport IPC、模块 MIME 等定向断言后实现。收口时唯一 MIME 红项已修复，未放宽 fence 或 requestId 断言。
- 以下指定矩阵 **52/52 PASS**：

```text
node --test tools/companion-desktop/test/session.test.mjs tools/companion-desktop/test/provider.test.mjs tools/companion-desktop/test/renderer.test.mjs tools/companion-desktop/test/turn-ipc.test.mjs tools/companion-desktop/test/voice-turn.test.mjs tools/companion-desktop/test/settings-store.test.mjs
```

- `node --check` **9/9 PASS**：`tools/companion-desktop/` 下的 `backend/session.mjs`、`backend/provider.mjs`、`backend/dialogue-pipeline.mjs`、`backend/worker.mjs`、`desktop/renderer.js`、`desktop/electron/main.mjs`、`desktop/electron/transport.mjs`、`desktop/electron/voice-turn.mjs`、`desktop/turn-contract.mjs`。`git diff --check` PASS。
- 本轮未运行 full suite/package、真实 DeepSeek/ASR/TTS、麦克风或播放/Cubism 验收；后置检查由 Emilia/YCA 执行。未启动 DSH，未 push/PR/merge/deploy。以上仅为 deterministic code 证据，不代表真实语音/Live2D 可用。
- Phase A 当前 blocker：无。durable usage 本 session 无可核实结果，记 unknown；run 终态 checkpoint 与 usage 由 Emilia/YCA 后置记录。


## 2026-09-26 真实语音验收

- Owner 使用真实 Windows 麦克风、北京区百炼 Key、`qwen-audio-3.0-asr-flash`、现有 DeepSeek Emilia 路径与真实扬声器执行实机验收。
- 首轮真实结果：ASR 与 DeepSeek 回复成功；TTS 返回后被现有媒体边界判为 `tts / INVALID_RESPONSE`。文字历史正常保留。
- 修复：TTS 请求改取 24 kHz / mono / 16-bit PCM，下行字节受原有 HTTPS/host/size/deadline/cancel 约束后由 Yuki Link 本地封装为标准 PCM16 WAV，再进入既有严格 playback / duration / owner fencing；上行麦克风 WAV 校验不放宽。
- 同时将语音日常入口收敛为单主按钮状态流：开始说话 → 说完 → 自动识别/提交/播放；取消、停止声音、播放重试只在对应状态出现；识别文本不再额外常驻调试框。
- 修复后 Owner 再次真实说话，ASR → DeepSeek → TTS → 物理扬声器完整成功，Owner 明确反馈“听到了，没什么问题”。
- deterministic evidence：受影响语音/renderer 回归 **65/65 PASS**；full suite **133/133 PASS**；`npm run check` PASS；Windows package 成功；packaged first/reopen/voice-credential smoke 全 PASS。
- 本次实机语音通过满足本票“真实麦克风→识别→模型回复→真实扬声器”的 voice 部分，不把 synthetic 证据冒充真实结果。
- Live2D 真模型 / Cubism Core / 实际 draw + mouth 仍因 Owner 暂无模型而保持 external-resource gate，未伪造通过。
- 后续完整视觉打磨明确延期；设计输入记录于 `docs/design/companion-ui-polish-direction.md`，要求先用 GPT Image 产出多张参考稿并由 Owner 选定后再实施，不在后续工程票中临时自由发挥 UI。

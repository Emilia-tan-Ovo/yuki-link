# 第三方来源与修改说明

本产品部分代码改编自 **AAAAGENT**，作者 phoiex 及项目贡献者，来源：https://github.com/phoiex/AAAAGENT ，固定提交 `2752349bcc7f7137b8b9e4ff9cccf34026d77aad`。

复用/改编范围：`desktop/electron/main.mjs`、`preload.cjs`、`transport.mjs`、`assets.mjs` 与 `backend/session.mjs` 的 Electron 隔离通信、资源协议、会话/文字对话结构。已修改为 Yuki Link 独立窗口、Electron 随包 utilityProcess、Emilia 单一持续对话、SQLite 日期历史与 DeepSeek 配置。

COMPANION-003 Phase B 新增改编：`backend/voice-provider.mjs` 参考上游 `providers/qwen-asr.ts`、`providers/qwen-tts.ts` 的请求与无损分段；`desktop/media/wav.mjs` 改编 `media/wav.ts` 的 PCM 编码/合并；`desktop/media/devices.mjs`、`recorder-worklet.mjs` 参考 `media/browser-capture.ts`、`media/browser-playback.ts`、`media/recorder-worklet.mjs` 与 `desktop/playback-controller.ts` 的音频生命周期、输出时间与 RMS。新增严格内存/时长上限、WAV 完整性验证、固定区域端点与下载主机、deadline/abort、设备选择与迟到结果清理；删除摄像头、持久化 MediaStore、情绪协议和自动重试，接入 Yuki 自己的提交与 scope owner。

未复制 AAAAGENT 的语音克隆/注册、Live2D、微信或工程派发代码/资产。第三方 Cubism SDK、模型、纹理和音色资源不随包提供；候选系统音色的服务使用条件及实际可用性须在真实验收时独立确认。

AAAAGENT 原创内容仍受其 **AAAAGENT 非商业使用及署名许可 1.0** 约束；完整许可见随包 `desktop/AAAAGENT-LICENSE.txt`。不得从本产品的改编推断商业授权或原作者背书。第三方依赖另遵循各自许可。

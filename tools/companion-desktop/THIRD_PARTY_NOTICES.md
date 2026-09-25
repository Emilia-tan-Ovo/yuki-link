# 第三方来源与修改说明

本产品部分代码改编自 **AAAAGENT**，作者 phoiex 及项目贡献者，来源：https://github.com/phoiex/AAAAGENT ，固定提交 `2752349bcc7f7137b8b9e4ff9cccf34026d77aad`。

复用/改编范围：`desktop/electron/main.mjs`、`preload.cjs`、`transport.mjs`、`assets.mjs` 与 `backend/session.mjs` 的 Electron 隔离通信、资源协议、会话/文字对话结构。已修改为 Yuki Link 独立窗口、Electron 随包 utilityProcess、Emilia 单一持续对话、SQLite 日期历史、纯文字模式与 DeepSeek 配置。未复制 AAAAGENT 的 Live2D、语音、微信或工程派发代码/资产。

AAAAGENT 原创内容仍受其 **AAAAGENT 非商业使用及署名许可 1.0** 约束；完整许可见随包 `desktop/AAAAGENT-LICENSE.txt`。不得从本产品的改编推断商业授权或原作者背书。第三方依赖另遵循各自许可。

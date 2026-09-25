# COMPANION-015 Implementation Notes

Source: GitHub #143 / Source Spec #125 US37 / AC16 / follow-up of COMPANION-014
Fixed point: `4d0f89229d880a2e7b10352b884170e3f7fa74bb`

## Implementation Decisions

- **唯一 committed source of truth：**主进程 `SettingsStore.snapshot().thinking` 仍是唯一已生效事实；`saveThinking()` 只有在原子 rename 成功后才发布新值。renderer 仅维护最近一次 `thinking-load` 或成功 `thinking-save` 确认的 committed 副本，供 Composer 与 Settings 两个入口渲染；DOM 值不是 committed source。
- **Composer 快捷入口：**输入框附近增加 `关闭 / Low / High / Max` 四档 selector。关闭映射为 `{enabled:false, effort:<最近一次 committed effort>}`，重新开启恢复最后档位；Low/High/Max 映射为对应 enabled effort。快捷选择自动保存，不再需要额外保存按钮。
- **Settings 与 Composer 双入口：**Settings 继续保留现有启用开关、effort select 与显式保存按钮，并与 Composer 共用同一 committed 副本。Settings 编辑值是独立草稿；任一入口保存成功后刷新 committed，并同步另一入口。若 Settings 草稿在 pending 期间发生用户编辑，则保留未保存草稿而不被成功回包覆盖。
- **首次 load 与发送门禁：**renderer 启动即主动 `thinking-load`；首次 committed 确认前禁止发送。Thinking 保存链未结束时允许继续编辑文本，但发送按钮禁用；`form` submit handler 也独立检查门禁，以覆盖 Enter 与程序化 submit。被阻止的消息不会在保存完成后自动补发。
- **快速切换策略（Owner 已确认）：**采用“单飞保存 + 只保留最新选择”。一个 `thinking-save` 未确认时，新的选择只更新 latest desired target，不并发发送；成功确认先更新 committed，再只保存仍与 committed 不同的最新 target。中间选择被合并。任一保存失败即终止链、丢弃未发送 desired、恢复快捷 selector 到最后 committed 值并显示错误；不自动重试。
- **生成中切换：**Thinking 状态独立于 `busy` / backend generation。当前已接受回合继续使用 submit 时冻结的 snapshot；生成中可修改并保存 Thinking，成功后只影响下一次真正接受的 submit。reconnect 不清除 pending chain，也不能让旧 load 覆盖更新的 committed。
- **接口边界：**完全复用现有 `thinking-load/save` IPC、preload 白名单、主进程 trusted sender、`SettingsStore` commit queue 与 `submittedTurn`；不新增 IPC、provider 字段或 renderer → worker 直接档位注入。renderer 保持单飞，因此现有无 request ID 的 save 响应足够。
- **Preview：**离线预览只验证本地 Thinking 保存与 UI/submit snapshot，不调用 DeepSeek、不生成假 reasoning。

## Test Plan

- `tools/companion-desktop/test/renderer.test.mjs`：首次 load 前禁止发送；四档映射与关闭保留 effort；快捷自动保存；pending 时文本可编辑但按钮/Enter/直接 submit 均不发送；成功确认后下一条使用新值；失败回退；快速 low→high→max 只保存首项与最新项；Settings ↔ Composer 双向同步与 dirty 草稿保护；生成中切换/reconnect 不破坏 pending。
- `tools/companion-desktop/test/settings-store.test.mjs`：沿用原子 commit 与 snapshot tests；补保存失败仍保持旧 snapshot、成功后下一次 snapshot 取新值、off 保留 effort。
- packaged smoke 增加最小 preview 行为：快捷选择 → 保存确认 → submit 使用新 requestedThinking → reopen 后 selector 仍显示 committed 值。复杂 pending/failure 矩阵留在 renderer deterministic tests。
- 完成后由 Emilia/YCA 执行 full suite、check、Windows package 与 packaged smoke。

## Out of Scope

不改 DeepSeek provider 协议，不发真实 DeepSeek 请求；不做模型切换、streaming、Memory、Voice、Live2D、移动端适配、自动重试或新的通用设置框架。COMPANION-014 的 reasoning 展示/隔离、timeout、no-retry 与发送时 snapshot 语义保持不变。

### Context Plan

- **Core:** GitHub #143；本 Notes；`AGENTS.md`；`docs/implementation-notes/COMPANION-014.md`；`tools/companion-desktop/desktop/{index.html,renderer.js,style.css}`；`desktop/electron/{main.mjs,preload.cjs,settings-store.mjs,submit-snapshot.mjs}`；`test/{renderer.test.mjs,settings-store.test.mjs,packaged-smoke.mjs}`。
- **Related:** #125 仅 US37/AC16；#140 仅既定 Thinking snapshot / persistence 语义。
- **Expansion triggers:** HEAD 漂移、出现第二个 Thinking 写入方、必须并发保存、或现有无 request ID 的 IPC 无法保证响应关联时，先回报再调整设计。

## Implementation Handoff

- Composer selector 与 Settings 共用 renderer 的最近一次确认值；启动在 `ready` 后请求首次 `thinking-load`，保存期间仅允许编辑文本，所有 submit 路径均阻止发送。
- 快捷选择合并为单飞保存与最新目标；失败恢复已确认值并丢弃待发目标。packaged preview smoke 已加入选择、保存、submit snapshot 与重开检查，待 Emilia/YCA 执行完整打包验收。
- 实现阶段仅运行 `renderer.test.mjs`、`settings-store.test.mjs` 定向测试及相关 `node --check`；full suite/package/packaged smoke 留给后置机械验收。

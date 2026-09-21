# HARNESS-015 Implementation Notes

Source Ticket: GitHub #84

Fixed point: `b3d0fef85b36500b79729535ed72d308762553dc`

## Implementation Handoff

- 身份：worktree `C:\Users\KQ_Sh\Desktop\yuki-link\.local\worktrees\harness-015`；branch `codex/harness-015-message-fade`；启动 HEAD 与 fixed point 均为 `b3d0fef85b36500b79729535ed72d308762553dc`，启动时工作区干净。
- 范围：只实现本次打开 Conversation 后新 append 的 `message` 逐字显示。纯函数以当前 high water、加载方向和已消费 message id 选出 reveal；初始历史、prepend、普通重渲染和非 message 不进入动画。
- 渲染：Prose 一次性建立完整 heading / paragraph / inline code / bold / fenced code 结构；grapheme span 只控制透明度且始终占位。短消息为 26ms/字，长消息按 grapheme 数加速并把总时长限制在约 3.2 秒；`prefers-reduced-motion: reduce` 直接完整显示。删除原有整条 Conversation item 的 opacity 动画。
- 数据边界：未修改 Journal、DTO、API、collector、原始 message、raw evidence 或复制文本；未实现 token streaming、显示名、Acceptance 文案或 icon/favicon。
- 测试（cwd `tools/codex-session-bridge`）：`node --test test/harness-conversation-reading.test.ts test/harness-conversation-rendering.test.js` 为 13/13、exit 0；`npm run typecheck`、`npm run typecheck:ui`、`npm run build:ui` 均 exit 0；仓库根 `git diff --check` exit 0。定向测试覆盖 baseline/append/prepend/同 id 去重、非 message、grapheme、长消息时长、SSR 完整结构及既有 grouping/scroll anchor。
- 环境：worktree 原 `node_modules` junction 的目标缺少 React；执行项目内 `npm install --ignore-scripts` 后依赖就绪，未修改 lockfile 或全局环境。
- 未验证：已启动本地 Vite 临时验证页并尝试 Computer Use；当前环境没有可用浏览器，in-app browser 报不可用，浏览器 inventory 返回空并伴随连接失败。因此真实浏览器 reveal 生命周期、reduced motion 和 bottom-follow 仍 pending，不能以 SSR/纯函数测试替代。
- Review：依 Owner 指令，本 implementation session 未执行 Review，也不提供 Review finding 或通过结论。
- Commit：提交主题 `feat: 为新自然语言消息增加逐字显示`；精确 SHA 与最终状态写入 ignored checkpoint `.local/workflow-state/HARNESS-015.md`。
- 模型成本：当前上下文无法取得 durable usage，记为 unknown，不使用模型估算。

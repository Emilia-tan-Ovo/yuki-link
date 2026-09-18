# Implementation Handoff

在本地 Ticket 追加同名 section；已有 handoff 则保留历史并明确当前版本。票据不可扩展时沿用仓库 Notes 位置，默认 `docs/implementation-notes/<ticket>.md`，checkpoint 指向实际路径。字段可用列表表达，无须引入新 tracker schema。

- 来源：Ticket/Issue、Spec、Implementation Notes。
- 身份：worktree/branch、已解析 fixed point、观察的 HEAD、受测内容摘要/引用；脏工作区列 tracked diff 和相关 untracked 字节。
- 范围：实际修改及与需求的对应关系，已知限制。
- 测试：实际命令/退出码、红灯与修复、最终结果、报告位置、受测内容/相关环境；未运行项明确写出。
- Review policy：本次 delegated 接收方，或 standalone 默认完整双轴；保留显式 full 要求。记录已执行的 Review 报告与内容绑定，尚未执行写 pending。
- Finding/risks：原 finding 标识与 open/fixed/verified、已知风险、未知事实；未执行 Review 不能写“零 finding 已通过”。
- Commit：实际 SHA 或 post-commit checkpoint 引用，提交未完成/未授权时的真实状态；不把旧 HEAD 当新 commit。
- 下一步：具体 reviewer/验收入口、必要证据与授权终点；不传 implementation 聊天。

写后回读。原始日志在 `.local` 等本机证据位置，Git 只保存短摘要；handoff 不承诺真实全局安装或日常 stable。若 handoff 随实现提交，checkpoint 在 commit 后记录精确 SHA，并绑定最终 staged/工作字节与测试摘要。后续只有记录性补充可单独确认证据一致性；引入行为变化时补受影响测试/Review。

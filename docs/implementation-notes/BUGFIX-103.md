# BUGFIX-103 — Implementation Notes

状态：设计已确认，直接进入实现。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/103
基线：`5967da02ab01b283198af46e733084966232b6bb`
worktree：`C:/Users/KQ_Sh/Desktop/yuki-link/.local/worktrees/bugfix-103`
branch：`codex/bugfix-103-review-authority`

## 目标

把 ORCH-003 已合并的 `start_ticket_review` review-authority 接线正式加入 Control Center / selected-release deployment，沿用 BUGFIX-101 已验证的 implementation-authority 模式，不重做 Review launcher 本体。

## 实现范围

1. `tools/control-center/src/config.js`
   - `yca.reviewLaunchAuthority` 为可选绝对路径；相对路径 fail-closed。
2. `tools/control-center/src/deployment.js`
   - selected release 的 launcher capability 同时探测、持久化并复验：
     - `--implementation-launch-authority`
     - `--review-launch-authority`
   - 旧 manifest / 不支持 release 仍安全表现为 false，不因开发 worktree 推断能力。
3. `tools/control-center/src/units.js`
   - 配置 review authority 时，先要求 selected release 明确支持 review flag。
   - 用 `FileReviewLaunchAuthoritySource` 启动前验证 authority 文件可信/可读；forbidden roots 与 implementation authority 一致。
   - 仅通过 argv 数组把 `--review-launch-authority <absolute path>` 传给受控 release。
   - 缺失、无效、不可信、release 不支持时 fail-closed。
4. `tools/control-center/config.example.json`
   - 补 review authority 示例。
5. 相邻 tests
   - config absolute-path validation。
   - launcher flag capability probe 同时覆盖 implementation/review。
   - YcaUnit 对 review unsupported 拒绝；supported 时 argv 确实包含 review authority。
   - public `start_ticket_review` 在未授权 Ticket 上仍 fail-closed。
   - 不扩大到 #108/#109。

## 验收边界

代码/fixture 阶段只证明接线正确。真实 production smoke 放在合并并部署 selected release 后执行：
- durable reserve Review child；
- fresh reviewer；
- 只绑定 Review child，不误绑 Main；
- 服务重启后同 operation 只读 reconcile，不重复启动 reviewer。

## Context Plan

- **Core:** GitHub #103；本 Notes；`tools/control-center/src/{config.js,deployment.js,units.js}`；`tools/control-center/config.example.json`；`tools/control-center/test/{deployment.test.js,supervisor.test.js}`；`tools/codex-session-bridge/src/{main.js,mcp.js}`；`tools/codex-session-bridge/src/orchestration/review-launcher.ts`。
- **Related:** `docs/implementation-notes/BUGFIX-101.md` 的 authority/deployment 先例；`docs/implementation-notes/ORCH-003.md` 的 Review launcher 契约。
- **Retrieval:** 优先 `git grep` / PowerShell `Select-String` 搜索 `implementationLaunchAuthority`、`reviewLaunchAuthority`、`launcherFlags`、`start_ticket_review`；`rg` 当前宿主不可依赖。
- **Expansion triggers:** 仅当 selected-release manifest 向后兼容、authority schema 或真实 production restart/reconcile 需要额外文件时扩展；#108/#109 不在本票处理。

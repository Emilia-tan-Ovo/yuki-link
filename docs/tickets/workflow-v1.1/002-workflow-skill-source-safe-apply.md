# 002 — 建立 Workflow Skill 来源与安全应用边界

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 让 Workflow v1.1 的 Skills 与稳定工作流规则拥有可版本化 source of truth，并能通过明确、可审计的安全流程应用到受保护的 Agent/Skill 环境，而不是让普通文件工具绕过保护直接改写自身指令。

**Blocked by:** None — can start immediately.

**Risk hint:** normal

**Status:** ready-for-agent

## Acceptance criteria

- [ ] 仓库中存在可版本化的 `engineering-workflow`、`review-change` 以及需要调整的现有 Skill source。
- [ ] repo-managed source 与用户安装目录之间的 source of truth / apply / refresh 语义明确。
- [ ] `AGENTS.md` 与 Agent/Skill 安装目录的现有保护边界不被普通 YCA 文件接口绕过。
- [ ] 能以受控方式预览将应用的 diff，并在真正写入受保护位置前保留明确授权边界。
- [ ] 安装/应用后能够重新读取已安装 Skill 并确认版本/内容来自预期 source。
- [ ] 搜索/应用流程不得假定 `rg` 一定存在；需要能力探测或可用 fallback。
- [ ] 不修改用户全局 Codex 配置。

## Implementation-design boundary

安全 apply 采用 repo script、人工批准步骤、专用受控能力或其他方案，由 ticket-design 决定。

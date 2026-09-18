# 001 — 解耦 Codex run 等待与执行超时

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 让 Emilia 可以高效等待 Sylvia 的 Codex run，而不会因为观察端等待窗口结束或统一的短 wall-clock timeout 把仍在正常推进的 Agent run 杀掉。

**Blocked by:** None — can start immediately.

**Risk hint:** high

**Status:** ready-for-agent

## Acceptance criteria

- [ ] YCA 对 observation wait 与 run execution deadline 使用明确、独立的语义。
- [ ] 等待“新事件 / run terminal / observation window elapsed”任一条件满足时可以返回，不要求调用方高频 `get_status → sleep → get_output`。
- [ ] observation window elapsed 不会停止仍在运行的 Codex run。
- [ ] Workflow 不再为了轮询方便给正常 Agent 工作统一附加短 execution timeout。
- [ ] 对持续产生有效进展的长 run，可在超过旧 180s/默认短墙钟阈值后继续运行；测试可以使用可控时钟/fixture，不要求真实等待数分钟。
- [ ] 如果调用方明确配置 hard execution deadline，超时仍产生清晰、可追溯的 terminal 状态与 `RUN_TIMEOUT` 语义。
- [ ] 主动 stop、客户端断开、observation wait elapsed、hard execution timeout 四者不会被混为同一状态。
- [ ] 保持现有 session/run 历史、cursor output、idempotency 与 terminal-state 兼容性。
- [ ] 通过 YCA MCP 公共边界完成真实验收。

## Implementation-design boundary

具体采用扩展现有 output/status、增加 wait 工具、可续期 deadline、无默认 hard deadline 或其他内部设计，由 ticket-design 根据现有 manager/store/MCP seam 决定；本票不提前固定 API。

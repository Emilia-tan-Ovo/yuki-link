# BUGFIX-109 — Control Center 切换观察与回执设计

状态：ticket-design 完成；仅供 fresh implementation session 使用。本轮只提交设计，不改实现。

Ticket：https://github.com/Emilia-tan-Ovo/yuki-link/issues/109 ；现场来源：#101 / #102 production rollout。固定点：`ba0995686d6939b0fbc917414994605f87aa3bb7`；分支：`codex/bugfix-109-control-center-projection`。真实现场的逐次诊断响应/进程时间线不在本 worktree；以下区分代码可证的错误链和仍需回归验证的具体触发时序。

## Context Plan

- **Core:** GitHub #109 验收；根 `AGENTS.md`；本文；`tools/control-center/README.md` 的状态、更新、回退与 operation 契约；`tools/control-center/src/{units.js,supervisor.js,host.js,common.js,server.js}`；`tools/control-center/scripts/process.ps1`；`tools/control-center/test/{supervisor.test.js,yca-integration.test.js,server.test.js}`。
- **Related:** `tools/codex-session-bridge/src/{diagnostics.js,main.js,source.js}` 只读确认 `/status` 身份、activity 与来源语义；`tools/control-center/test/deployment.test.js` 的真实 release 验证先例；`docs/control-center-baseline.md` 的归属边界。#101/#102 rollout 仅用于解释现场，不把历史 Notes 当当前运行证据。
- **Retrieval:** 宿主没有 `rg`；使用 `git grep`、PowerShell 7 的 `Select-String` 与精确行段读取。关键词：`ACTIVITY_UNKNOWN`、`OBSERVED_UNOWNED`、`startOne`、`rollbackDeployment`、`deployment-switched`、`addOperation`、`operationOutcome`。完整大日志和其他 Ticket 保持冷状态。
- **Expansion triggers:** 若定向复现表明故障来自 YCA `/status` 合约、Windows 进程脚本或事件持久化本身，先定位证据，再仅扩展到必要的 Control Center 文件；任何需要改 `tools/codex-session-bridge` 的方案须回到本票边界讨论，不能在本票触碰。

## 根因模型与证据边界

1. `YcaUnit.start()` 先持久化新的 `instance`、`token`、目标部署，再 spawn；spawn 后的 OS inspect 若尚未找到进程，`state.process` 暂为空。`YcaUnit.observe()` 依赖 `process.ps1` 的命令行标记定位进程、OS 身份匹配确认 ownership、用该 token 访问独立 `/status`，并核对 `instance/pid/service`。诊断面是在 YCA HTTP 启动、工具摘要计算后才监听；普通 `/healthz` 与诊断认证不是一次原子观察。于是启动后短窗可见进程却暂时取不到匹配的 `/status`：已有 OS 身份时投影 `ACTIVITY_UNKNOWN`，尚未持久化 OS 身份时投影 `OBSERVED_UNOWNED`；`healthy=false`。若后续诊断成功，现有代码能恢复 `state.process` 并观察到正确的 source/tools/activity。HTTP `403`、旧 token/instance、暂不可达和真正外部进程在当前投影中容易收敛成同类缺证据状态。
2. `Supervisor.startOne()` 把 `ACTIVITY_UNKNOWN`、`OBSERVED_UNOWNED` 列入永久错误，且所有 `DEPLOYMENT_*` 错误立即抛出；因此它可能在既有 `startupMs` 观察期限内首次遇到暂时性认证失配时直接退出。`updateDeployment()` 已停止旧 A、开始启动 B 后把这次观察失败送入 rollback。`rollbackDeployment()` 若仍缺认证来源或归属，无法满足 candidate 的 commit + recorded commit + instance 条件，便抛 `DEPLOYMENT_ROLLBACK_CONFLICT`；catch 又把它写成 failed terminal。稍后的 direct `/healthz`、已认证 activity=0/0/0 和目标 source/tool 一致，只证明当时 B 健康，不能倒推此前每一次探测的确切失败原因，但与这条代码路径吻合。
3. 另一独立语义缺口：`updateDeployment()` 的 catch 同时包住切换与 `deployment-switched` 事件写入；若 B 已验证、只是报告事件失败，现有代码仍可能进入 rollback。`state.ownership.deployment` 是启动前持久化的目标意图，不是切换成功证明；`deployment-switched` 非 operation terminal，也不能替代带身份的现时核验。`Events` 只持久化 requested/succeeded/failed；requested-only 在重启后应保持 unknown。

## Implementation Decisions：证据、状态与终态

- **观察证据分层。** `running` 只来自新鲜 OS/端口观察；`owned` 仍须满足 OS PID、创建时间、路径/启动标记及该实例的认证身份，缺诊断时不能授予停止权；activity 只接受当前实例认证 `/status` 中结构合法的非负计数，缺失、拒绝或不匹配即 unknown。`/healthz` 只证明 HTTP 健康，不能单独证明 ownership、空闲或 release；source commit、dirty=false、工具摘要必须来自同一已认证实例，并与本次准备的目标匹配。selected/recorded launch intent 不充当 running 证据。观察刷新按本次 `instance/token` 和 OS 进程身份重新核对，绝不沿用旧实例的 activity/source。
- **启动观察状态。** 对本次受控 `start()` 已记录的动态 instance/token/目标，`startOne()` 在既有 `startupMs` 窗口中把进程可见但诊断尚不可用、启动后的 OS inspect 尚未稳定等视为 *pending observation*；继续现有短间隔重查，不延长 sleep/总期限，不将未知判健康。已确认的多实例、端口/旧锁冲突、错误 release/工具摘要、确实不同的进程身份等仍按既有拒绝路径；超出窗口且缺关键证据是 unverified/unknown，不能伪装成功或授权停止。普通 `observe()`/手动 `recheck` 更新当前投影，不受一次旧失败永久污染。
- **切换状态机。** `preparing` → `A 已复验` → `A 已停/候选 B 启动中` → `B 已认证且身份、健康、commit、tools 全匹配` → `switched`。只有最后的完整证据允许成功终态。进入回退前重查现时证据：若同一候选 B 此时已完整验证，保留 B，完成成功；若明确是本次候选但未通过验证，仅在新鲜 ownership 与 activity 足以安全停止时按既有限定回退 A；若已回到已验证 A，则记录切换失败且恢复成功；若是可证的其他实例，报告真实 conflict 且不动它；若归属、activity 或 switch 结果仍未知，保留现场，不强杀、不猜回退、不把观察失败写成已确定的 rollback conflict。必须比较动态 candidate instance 与 OS 身份，不能仅凭 B 的 commit 或当前 selected 判候选。准备前/后二次 guard 与进程变化检查继续保留。
- **receipt 与持久化。** 操作在副作用前的确定性拒绝，以及安全回退已完成/可证冲突后的确定性失败，可写 `failed`；本次候选完整验证且完成必要持久化后写 `succeeded`；副作用可能已发生但最终 switch/回退证据不足，或状态/terminal 事件持久化失败，则保留 requested-only，HTTP 返回 `operationOutcome=unknown`。报告事件写入异常不得把已经证实成功的 B 当作启动失败来回退。事件写入顺序和异常边界应让 `deployment-switched` 仅描述已证实的切换，operation terminal 与对外 receipt 使用同一个已决定结果。重启后的 requested-only 不由当前 snapshot 追认终态：当前 B 健康和旧 operation 的因果关系不能仅凭版本相同重建。`server.js` 现有 unknown 映射与页面不自动重试的契约优先复用。
- **安全不变量。** 用户确认活动影响不等于确认未知 ownership；`YcaUnit.stop()` 对未认证 activity/归属继续拒绝。诊断 token 只用已有随机生成及本地状态，不暴露、不写死、不降低认证；既有 30 秒启动观察期限不增加。没有自动恢复、删除锁/进程、改变 tunnel 或扩展跨服务协议。

## Implementation Plan 与写集边界

1. 在 `tools/control-center/src/units.js` 将 OS 观察、认证诊断、activity、健康、release 来源的有效性明确表达；新旧 token/instance 切换时不复用上一个实例的结论，仍保持 stop 的严格校验。只在必要时微调同目录 `host.js`/`scripts/process.ps1`，以定向复现为前提。
2. 在 `tools/control-center/src/supervisor.js` 为本次 start/update 区分暂时性观察不足、硬冲突与已验证 outcome；复用既有启动期限，对候选完整验证后收敛成功；回退前按当前身份与 activity 再核验，并隔离报告失败与切换失败。保留已有 prepare 期间 recheck 和串行化。
3. 在 `tools/control-center/src/common.js` 的既有 operation event 契约内保留 requested-only unknown；如确需表达更多终态因果，仅做与 `server.js`/页面兼容的最小调整。预期无需修改 `tools/codex-session-bridge/**`、deployment 准备协议、配置或前端文案。
4. 用定向测试驱动并核对 receipt 与重启后事件恢复；随后运行 Control Center 现有测试。生产真实链路验收须在实现部署后独立进行，不能用隔离测试称为 rollout 已验收。

## 最小测试矩阵

| seam | 必须证明 |
| --- | --- |
| `test/supervisor.test.js`，受控启动 | restart/update 后先观察到进程但诊断暂不可达或认证尚未匹配，随后在原观察期限内转为已认证、activity=0/0/0、目标 commit/tools、healthy：不回退，operation 为 succeeded；手动 recheck 投影恢复。 |
| `test/yca-integration.test.js` 或相邻 `YcaUnit` 定向夹具 | 新 `instance/token` 与 OS 身份绑定；旧 token/旧 instance 响应、403、缺/畸形 activity、缺 OS 身份均不能证明 owned/idle/healthy，也不能停止；诊断恢复后新实例可正确识别。 |
| `test/supervisor.test.js`，回退分支 | B 启动后第一次观察未知、回退前已完整验证 B：保留 B 且 succeeded；本次 B 可证但确实未通过验证且安全空闲：只停止 B 并恢复 A，记 failed；外部替换进程继续 conflict 且绝不停止；证据仍未知则 requested-only/unknown。保留现有同 commit 外部替换保护。 |
| `test/supervisor.test.js` + `test/server.test.js`，receipt | 副作用后的状态/terminal 写入失败、连接终态前中断仍 unknown；已验证成功后的非关键报告故障不触发回退；持久事件与 HTTP 回执一致，重启读取 requested-only 仍 unknown，recheck 不补造旧 terminal。 |

低风险细节（辅助函数名、错误码内部映射和夹具组织）交实现阶段按现有风格决定。若现场逐次响应表明另一原因，先更新根因证据与最小设计，再改实现。下一步：fresh implementation session 从本 Notes、fixed point 与当前 Git 事实启动；本设计不包含实现授权。

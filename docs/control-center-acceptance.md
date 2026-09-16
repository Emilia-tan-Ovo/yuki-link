# Control Center V0 验收记录

2026-09-17 收尾，Windows 本机。**Control Center V0 当次验收通过：ChatGPT → YCA → PowerShell、计划任务生命周期、合盖 Modern Standby 后恢复、真实断网后恢复均有实际通过证据；重启/重新登录自启验证到 Control Center/Supervisor。** 不将其扩大为长期稳定性或关闭自动恢复时的 YCA/tunnel 登录自动启动保证。实际拓扑和配置依据见 [baseline](control-center-baseline.md)，入口/日志/自启/回滚见 [使用说明](../tools/control-center/README.md)。

## 最终真实验收

以下记录依据用户提供的真实验收结果，并与本票源码核对。此次收尾只复核代码、更新文档和运行隔离测试，不重复操作正式服务或计划任务。先前接管快照保留在后文，不能当作最终状态。

| 场景 / 证据来源 | 实际结果与结论 |
| --- | --- |
| 人工 ChatGPT 端到端验收 | ChatGPT → YCA → PowerShell 多次真实成功，PowerShell `7.6.5 / Core`、`exit_code=0`。工具 14 项，SHA-256 `e876dcb5c870702679e18736867aff2844011af293e36c608a1bd3565f564e0c`。最终现场再次调用成功；这些是当次端到端证据，不是面板自动探测的结论。 |
| Startup Preview / Status 与真实生命周期 | Preview/Status 通过；真实 Install → Status → Disable → Enable → Uninstall 通过。任务属性为 Interactive/Limited、IgnoreNew、RestartCount=3、RestartInterval=PT1M、ExecutionTimeLimit=PT0S；允许电池运行、不要求网络、不唤醒。卸载导出 XML，最终测试任务已卸载。任务属性核验不等于实际触发完三次失败重试。 |
| 合盖 Modern Standby | Windows Kernel-Power 506/507，原因 Lid，支持此次实际进入/退出 Modern Standby。唤醒后端到端调用成功；当时 Supervisor/YCA/tunnel PID 未变化。control plane 短暂 `HTTP_TIMEOUT` 后出现 `poll-recovered` 和 `forwarded-to-mcp`，无需人工重启或重装。该结论限于当次合盖待机场景。 |
| 用户真实断网 / 恢复 | 断网事实来自用户操作；期间 tunnel/Control Center 连续记录 `poll-failed` / `HTTP_TIMEOUT`，网络恢复后出现 `poll-recovered` → `forwarded-to-mcp`，随后端到端调用成功。PID 未变化，`autoRecovery=false`，符合存活 tunnel 自身网络重试的实现。额外 Windows 网络事件查询被平台拦截，未取得独立 Event Log 网络证据。 |
| Windows 重启 / 重新登录 | 登录计划任务成功拉起 Control Center/Supervisor；新 Supervisor PID 11924，`startedAt=2026-09-16T15:37:08.231Z`，15:37:15 UTC 记录 supervisor ready。当时 YCA/tunnel 均 `desired=running`、`running=false`、`retries=0`，`autoRecovery=false`。因此登录自启仅验收到 Control Center/Supervisor。 |
| 登录后手动“启动全部” | 用户随后手动启动全部。tunnel 初始显示“降级”，但 `running/healthy/ready=true`、controlPlane healthy；当时 `recentEvents` 为空、communication 为 `unknown-or-expired`。ChatGPT 真实调用成功并产生 `forwarded-to-mcp` 后，communication 变为 `recent-local-evidence`，状态变为“可用”。初始降级不是启动失败。 |
| 两条错误的上下文 | 曾出现 `32600 Session terminated`，另一通道出现 `404 tunnel_client_not_seen`；后续本机诊断确认当时重启后的 YCA/tunnel 未运行。仅记录先后观察，不据这两句错误推断会话过期、凭据故障、休眠根因或重装必要性。 |
| 最终现场 | 计划任务已 Uninstall；`allowStartupChanges=false`、`autoRecovery=false`、`observeOnly=false`；YCA/tunnel 保持运行，最终端到端 PowerShell 调用再次成功。运行时 XML 备份仅保留在 `.local`，不提交。此处为验收结束时状态，不承诺后续持续不变。 |

### 源码复核与证据分层

- `scripts/Startup.ps1` 启动 `Run-Supervisor.ps1`，后者运行 Supervisor；`src/main.js` 初始化后调用 `tick()`。`src/supervisor.js` 的 `tick()` 在观察后遇到 `autoRecovery=false` 即返回，不因持久化的 `desired=running` 自动启动服务。手动“启动全部”走独立的 `action()` 路径。此次不扩展 V0 的登录启动策略。
- `src/units.js` 分开记录进程、readiness、control plane 代理健康和有限日志通信证据；`src/supervisor.js` 在缺少近期通信证据时将健康的 tunnel 显示为“降级”。`forwarded-to-mcp` 是本地转发证据，本身不证明工具执行成功；需结合人工 ChatGPT 返回结果。
- 页面 ChatGPT 字段保留“未在此验证”，准确含义是本地面板不自动验证 ChatGPT；与本记录中人工端到端验收已通过并不冲突。工具摘要是验收时计算值，不是固定常量或 ChatGPT 缓存探测。

## 早期正式接管与本机验收（历史快照）

用户明确授权范围内，2026-09-16 22:48–22:52（UTC+8）执行；该阶段尚未进行休眠、断网、注销、登录或插件重装测试，也没有调用模型。后续系统及 ChatGPT 验收已完成，见上文。

| 检查 | 实测结果 |
| --- | --- |
| 接管前进程及锁 | 旧 `bridge.lock` PID 17280、官方元数据记录的 tunnel PID 7812 均不存在；7391/7393 无监听；只有观察模式 Supervisor PID 20464 监听 7392。6 个会话、11 条运行记录均无 queued/running/stopping 任务。现存两个 Codex 均为 app-server 且父进程存活，未发现相关孤儿 Codex 执行进程或电脑工具子进程。旧锁核验后复制备份并移开，没有删除或强杀旧服务。 |
| 正式启动 | 本地配置仅将 `observeOnly` 从 true 改为 false，核验身份后退出旧 Supervisor 并用 README 入口重启。刷新页面后点击“启动全部”；YCA 启动成功，官方 managed runtime connect 退出码 0。 |
| 控制中心与单实例 | 页面真实渲染，YCA 显示“可用”，tunnel 显示“降级：本地就绪；远端通信证据不足，不等于断线”。重复执行打开入口两次，Supervisor PID 21752 和实例标识保持不变；OS 核查 Supervisor/YCA/tunnel 各 1 个，YCA PID 23832、tunnel PID 24376。Supervisor 重启后旧页面会话失效，刷新页面即可重新连接。 |
| YCA 健康与归属 | 固定可执行路径、PID/创建时间、实例标记及受认证诊断通过；新锁 PID 与正式 YCA 一致。健康检查正常；验收后 Codex/电脑工具/请求活动数均为 0。实际注册仍为 14 项，工具摘要与本地一致。 |
| 正式 tunnel | `/healthz` HTTP 200 且正文严格为 `live`；`/readyz` HTTP 200 且正文严格为 `ready`；`/api/status` tunnel 身份与原 profile 一致。22:51:34 采样时，`/api/system` 的 control_plane 代理状态 healthy，证据时间 22:50:58。这些证据仅证明本地就绪与代理可达，不证明 ChatGPT 到工具的端到端调用。 |
| 近期通信证据 | 有限原生日志投影未取得近期 poll-recovered / forwarded-to-mcp 证据，状态 `unknown-or-expired`；如实保留未知及页面“降级”，没有因此重启服务或宣称断线。 |
| 本机只读 MCP | 22:50:42 经 SDK 连接 `http://127.0.0.1:7391/mcp`，完成 tools/list 后仅调用一次 `powershell` 的 `version` 查询。返回 `7.6.5 / Core`、exit_code 0、isError false；审计状态 completed。该调用直达本机 YCA，未经过 tunnel 或 ChatGPT。 |
| 配置与历史保留 | 原 runtime、allowlist、Codex 绝对路径、tunnel ID/alias/profile/凭据引用均保留，未新建 tunnel/key。官方 connect 前备份 profile，启动后 profile 字节摘要与备份一致。启动前 21 个 runtime 文件中，仅 `computer-audit.jsonl` 因本次查询追加而变化；sessions.json 和全部原有运行历史摘要一致。未升级依赖或修改 MCP 定义。 |
| 当时开关与未验证项 | `autoRecovery=false`，`allowStartupChanges=false`；计划任务 installed/enabled 均为 false。页面 ChatGPT 显示“未在此验证”；此阶段尚无人工端到端验收，账号/模型未测试。 |

### 本地备份与证据

以下路径相对仓库根目录，均在忽略目录内，不提交真实连接标识或凭据引用：

- `.local/control-center/acceptance-20260916-224914/`：`config.before.json`、`binding.before.json`、`tunnel-profile.before.json`、`bridge.lock.copy` 与移开的 `bridge.lock.retired`；锁仅作取证保存，不应重新放回运行目录。
- 同目录：`runtime-inventory.before.json`、`status.before.json`、`status.after.json`、`takeover.json`、`single-instance.json`、`tunnel-evidence.json`、`preservation.json` 和 `local-mcp.result.json` 保存本机验收证据；状态快照已移除 CSRF，不包含控制 token 或原始服务响应。
- 官方启动适配器的额外 profile 备份：`.local/control-center/runtime/tunnel-profile-1789570196049.json`。本次无需恢复，因为前后字节相同。
- 原 Supervisor 状态文件在接管前不存在（使用默认关闭恢复/期望停止状态），因此没有虚构 `state.before.json` 备份；接管后的状态由控制中心正常创建。

### 回滚方法（本轮未执行）

1. 保持自动恢复关闭，先在面板重新检查活动任务；确认空闲后“停止全部”，等待 YCA/tunnel 都退出。出现未知归属、活动任务或停止超时就保留现场，不强杀。
2. 核对 7392 的 Supervisor 可执行路径、配置路径、PID 和创建时间后退出该管理器。若只退回观察模式，将 `config.before.json` 恢复到 `.local/control-center/config.json`，再用原入口打开；期望状态应在上一步通过正常停止保存。
3. 如需恢复旧部署，管理器退出、7391/7393 无占用后，使用保留的 `.local/start-yca.ps1` 与原官方 runtime 入口；继续复用原 alias/ID/profile/凭据引用。profile 若确需恢复，只在对应 tunnel 已停止时恢复该 alias 的备份，不覆盖官方全局状态文件。
4. 如存在计划任务，先 Disable 或 Uninstall；最终验收现场已卸载，无需重复操作。保留原 runtime、session/history 和本次备份；不恢复失效旧锁、不删除目录来“重置”。

## 此前代码及隔离验证（历史记录）

| 层级 | 方法与结果 |
| --- | --- |
| 控制中心自动测试 | `tools/control-center` 的 `npm.cmd test`：16/16 通过，0 skipped。模拟 native runtime，不调用正式 tunnel、不读取 key。 |
| 既有 Bridge 回归 | `tools/codex-session-bridge` 的 `npm.cmd test`：42/42 通过，0 skipped，包括新增配置保护测试；在保留原有 catalog 修复/测试的当前工作区执行。 |
| 本机隔离进程 | 临时目录、动态端口、真实 Node 24.18.1 / PowerShell 7；重复 YCA 启动保持同一 PID；管理器重建后验证实例 token/创建时间；错误创建时间拒绝停止；模拟 YCA 崩溃后备份自有旧锁并恢复；优雅停止确认退出。未调用模型。 |
| 真正的 Supervisor 崩溃 | 独立 Supervisor 子进程强制退出后重启，继续识别原 YCA PID、不重复启动；第二个管理器因端口占用退出；保存“停止”后再次杀掉/重启 Supervisor，YCA 保持停止。全部为测试实例。 |
| 恢复故障注入 | 连续失败跨管理器重启保持预算，第五次后暂停；手动停止取消恢复；模拟长间隔令旧证据失效并给予宽限；活着的 tunnel 降级不触发重启；任务活动/未知时不盲目重启。 |
| Native adapter | 模拟对应版本的 profile、process metadata、HTTP health/system/status；验证显式复用 ID、禁止 create、PID 复用冲突、状态身份不符、拒绝覆盖自定义 profile；只由原生 connect/stop 负责 tunnel，不另起 daemon。该隔离测试不调用正式 connect/stop；正式启动记录见上文。 |
| 安全与日志 | 错误 Host/Origin、缺 session/CSRF、非 ASCII 伪造 cookie、GET 修改、额外命令参数被拒；诊断无 session/CSRF/YCA token；带假凭据/URL/headers 的日志仅输出固定事件字段；日志轮转通过。 |
| 工具契约 | `src/mcp.js` 未修改；从实际注册生成 14 项，SHA-256 `e876dcb5c870702679e18736867aff2844011af293e36c608a1bd3565f564e0c`。没有新增控制中心 MCP 工具；该数字和摘要是本次计算结果，不是运行时常量。 |
| 自启准备 | 4 个 PowerShell 脚本 AST 解析通过；`Startup.ps1 -Action Preview` 从实际生成的任务对象验证 Interactive/Limited、IgnoreNew、3 次/PT1M、PT0S、允许电池且不因拔电停止、无外网前置、不唤醒；未注册计划任务。 |
| 浏览器 | 本机 7392 观察页面已渲染；正式启停/恢复/自启按钮禁用；显示未受管旧锁和“ChatGPT 未验证”；CLI 检查显示实测版本，复制诊断成功；中文编码已修正。重复打开入口保持同一后台 PID；关闭网页后 HTTP 仍 200、后台存活。 |
| 源码检查 | `node --check`、PowerShell AST、`git diff --check`；新增文件扫描未含真实用户名、连接 ID 或 key。已有无关未提交内容保留。 |

## 2026-09-17 收尾复核

- Review 固定点为 `b7cfea2`（Control Center 提交之前），并复核此次两份文档工作区改动。Standards / Spec 两路审查均未发现需修复的明确问题；只更新本验收记录和 Control Center README，没有扩展功能或修改 Bridge。
- `tools/control-center`：`npm.cmd test` **16/16 通过，0 failed，0 skipped**。首轮受沙箱 CIM 访问限制影响为 14/16，两个真实进程测试报 `PROCESS_OBSERVATION_FAILED`；单独核查 `Get-CimInstance` 返回拒绝访问，改在正常 Windows 权限上下文重跑后全部通过，未为此修改源码。
- `tools/codex-session-bridge`：`npm.cmd test` **42/42 通过，0 failed，0 skipped**。本票既有提交涉及 Bridge 诊断面和路径保护，因此补跑回归；测试是在保留无关 catalog 源码/测试改动的工作区执行，不将这些改动纳入此次提交。
- 16 个 Control Center JavaScript 文件 `node --check`、4 个 PowerShell 脚本 AST 解析、两份文档 `git diff --check` 和定向隐私扫描通过。此次测试采用临时目录、随机端口、模拟 native runtime 和独立 YCA，不重启正式服务、不读取真实 tunnel key，也不安装计划任务。
- 无关未提交文件共 10 个，收尾期间用 SHA-256 与开始时逐一对照保持一致；只按两份文档路径暂存并复查差异，`.local` 运行时证据不提交。

## 仍未验证的范围

1. 长期稳定性及超出当次端到端调用的长期可用保证；不同待机模式和其他网络环境也不能从此次场景推定。
2. `autoRecovery=false` 时重启后 YCA/tunnel 自动启动：未验证通过，现有源码与现场均表明需手动启动；不作为此次 V0 的通过项。
3. 普通用户计划任务实际失败重试次数耗尽及完整回滚；本次验证了任务属性、生命周期和登录启动，隔离故障注入不能替代这些系统行为。桌面快捷方式未创建；目前提供仓库内双击入口与本地网页。
4. Codex 账号状态与模型调用未在本控制中心验收中验证；不推断 ChatGPT 缓存或旧会话状态。

## 明确保留的边界

- 未受管旧锁、未知实例、不可观测的活动任务、停止超时或孤儿进程，不自动删除/强杀；先保留诊断并暂停。这是 V0 的保守人工处理边界。
- 本机 readiness/system、近期日志和人工 ChatGPT 端到端结果分别记录。人工调用已通过，不把本地“可用”推广为远端持续可用保证。
- 原生 `runtimes status` 在 baseline 阶段曾隐含尝试远端只读查询；确认源码后不再用作本地轮询。Supervisor 的周期检测不使用该命令，也不使用 doctor。
- 不宣称“Session terminated”、休眠或网络超时中的某一个是早期故障根因。早期正式服务退出原因仍未定位；后续重启时未运行的现场事实不反向解释早期退出原因。

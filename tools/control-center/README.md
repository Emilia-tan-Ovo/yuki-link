# Yuki Link · Control Center V0

独立 Node Supervisor + 原生网页，固定支持本机已核实的 **HTTP YCA + tunnel-client 0.0.14 managed runtime**。不更改 MCP 传输，不管理其他插件，不增加 MCP 工具。先看 [baseline](../../docs/control-center-baseline.md)。

## 打开与本机配置

要求 Windows、Node 24+、PowerShell 7。YCA 部署准备另需 Git 和该 Node 安装附带的 npm CLI；没有新增 npm 依赖。配置使用原生 `.exe` 绝对路径，拒绝把 `.cmd/.bat/.ps1` 当原生程序启动；PowerShell 脚本统一经 `pwsh.exe -File`。

本机配置准备在仓库 `.local/control-center/config.json`，并生成 `.local/control-center/Open-ControlCenter.cmd`。该入口查找同一面板或隐藏启动后台，再打开浏览器。配置/状态/凭据引用不提交 Git。其他机器以 `config.example.json` 为结构示例，所有路径应重新核对，不能直接运行示例。

```powershell
pwsh.exe -NoProfile -File tools/control-center/scripts/Open-ControlCenter.ps1 -Config .local/control-center/config.json
```

控制页默认 `http://127.0.0.1:7392`；YCA MCP 保持 7391，受限诊断面使用独立 7393，不由 tunnel 转发。正式启动授权前 `observeOnly=true`，只观察已有元数据和本地健康信息，启停/恢复被服务端拒绝。**截至 2026-09-17 收尾，正式接管、人工 ChatGPT → YCA → PowerShell、真实合盖 Modern Standby/断网恢复及计划任务生命周期验收通过；登录自启验证到 Control Center/Supervisor。** 最终验收现场已卸载计划任务，`allowStartupChanges=false`、`autoRecovery=false`、`observeOnly=false`，YCA/tunnel 保持运行。实际结果与证据边界见 [验收记录](../../docs/control-center-acceptance.md)。

正式部署步骤：用户确认 → 复验正式进程/活动任务 → 备份处理 baseline 的未知旧锁（不能当作控制中心自己的锁）→ 将本地 `observeOnly` 设为 false → 重启 Supervisor → 在面板启动全部。保持原 runtime、allowlist、Codex 绝对路径、tunnel alias/profile/密钥引用。`connect` 固定传现有 tunnel ID，禁止无 ID 创建；原生命令会读取已有凭据认证，需纳入正式部署授权。

## 状态与恢复

### 常驻 YCA 源码部署（Issue #11）

常驻服务可使用 Control Center 配套管理的部署目录。它与 `yca.runtime`（原 service runtime/session/history）是两回事，**部署 runtime worktree ≠ 强制开发 worktree**。开发票据仍可使用自己的工作目录、分支和未提交修改。本流程不更新开发分支，不执行 clean/stash/reset，也不创建 tunnel/key。

部署目录首次必须不存在；工具独占创建 `owner.json`、独立 bare 仓库及 `releases/<commit>` detached worktree。每次读取开发仓库 `origin` 的实际远端 HEAD，抓取其默认分支已合并 tip。源码/依赖按 commit 保留，不在运行中的版本上 checkout 或 npm ci。相同 commit 复用原副本，重新校验 HEAD、工作树、lockfile、Node 主版本及实际 MCP 工具摘要。不会累计相同 commit 的未知 worktree，也不会自动删除历史版本。

在 PowerShell 7 中执行（以下路径是示例，`$cc` 指含本修复的 Control Center；首次正式准备必须等本修复合入默认分支）：

```powershell
$repo = 'C:\projects\yuki-link'
$cc = 'C:\projects\yca-runtime-deploy-fix\tools\control-center'
$deploy = Join-Path $repo '.local/control-center/yca-deployment'
$node = 'C:\Program Files\nodejs\node.exe' # 与正式 config.node 相同
& $node (Join-Path $cc 'scripts/Prepare-YcaRuntime.js') --repo $repo --root $deploy --node $node
if ($LASTEXITCODE -ne 0) { throw '部署准备失败，保留原服务与现场' }
```

如果 npm 不在 Node 相邻的 `node_modules/npm/bin/npm-cli.js`，显式传 `--npm-cli <绝对路径>`。入口以 `node npm-cli.js ci --ignore-scripts --no-audit --no-fund` 准备锁定依赖，不通过 shell 拼接命令。JSON 成功结果包含 `commit/branch/entry/cwd/tools/dependencies`；`installed` 表示本次安装成功，`reused` 表示原副本校验及工具加载成功。它只原子更新 `selected.json`，**不停止服务、不修改正式配置、不触碰 tunnel**。Node/npm/Git 的路径、网络或依赖失败都以非零退出及固定错误码报告，不输出原始凭据或命令输出。

首次接入按下列顺序进行，仍使用原配置文件的绝对路径及原 `stateDir`，否则既有目录绑定会拒绝启动：

1. 保存原配置、启动入口和面板诊断作为回滚依据。确认现有 Codex/Node/PowerShell 路径有效；本修复不搬入开发目录未提交的其他路径修复。
2. 用**现有面板**关闭自动恢复，查看所有权和活动任务。只停止 YCA；有任务时等待结束，或由用户明确确认中断；活动未知、归属未知、停止超时则停在这里，不强杀、不移除未知锁。确认 YCA 已退出。tunnel 可以继续运行，短暂无上游不代表需要重建连接。
3. 核实并退出原 Supervisor，再备份并编辑原 `config.json`：只增加 `yca.deploymentRoot` 为 `$deploy`。保留 `yca.entry/cwd` 作为旧部署路径记录；启用该字段后，启动必须读取已准备的部署副本，绝不静默退回开发目录。原 `yca.repo/runtime/port/controlPort`、`stateDir`、tunnel profile/key 引用均保持原值。保留关闭的自启/自动恢复状态。
4. 从此次输出 `cwd` 的相邻 `tools/control-center/scripts/Open-ControlCenter.ps1` 启动新版 Supervisor，`-Config` 仍指原配置文件。将本机 Control Center 启动入口指向这个固定、已核验版本的脚本，不能再指向开发分支。已有计划任务如需换入口须另行按原自启流程授权，本流程不修改计划任务。
5. 面板点击 YCA“启动”，核对下面的独立验收。Supervisor 仍按原进程身份/诊断认证核验所有权。部署路径在启动前固定到实例记录，准备新版或重启 Supervisor 都不会丢失旧进程的所有权证据。

以后更新只需重新执行准备命令，再由面板显式“重启 YCA”（也可停止后启动）。准备期间 `update-pending` 表示旧进程仍运行；自动恢复只拉起上次已启动的 commit，不会趁旧进程退出时自动切换候选版。没有历史部署记录时自动恢复拒绝首次切换。无需手工复制源码。Control Center 本身的升级仍需上述 Supervisor 退出及入口切换；YCA 更新不隐式升级 Supervisor。

失败语义：

| 情况 | 结果与处理 |
| --- | --- |
| `DEPLOYMENT_NOT_OWNED/CHANGED/LINK_REFUSED` | 未知目录、远端改变、部署内容被修改或目录链接，拒绝覆盖；保留现场核查 |
| `DEPLOYMENT_DEPENDENCIES_FAILED` | 不改变已选版本；确认原因后可重试同一个工具拥有、尚未发布且干净的副本 |
| `DEPLOYMENT_PROTOCOL_UNSUPPORTED/PROBE_FAILED` | 源码缺少本修复的部署协议或依赖/工具加载失败，不发布候选版 |
| `DEPLOYMENT_INCOMPLETE` | 已发布副本的清单遗失等不完整状态，不在可能运行的源码上重装；核查或使用新的部署根目录 |
| `DEPLOYMENT_BUSY` | 更新锁已存在；不能凭 PID 猜测后自动清锁 |
| `COMMAND_TIMEOUT/OUTPUT_LIMIT` | 可能存在未结束的 Git/npm 后代，保留更新锁；人工核验进程全部退出后备份移开锁再重试 |
| `DEPLOYMENT_NODE_CHANGED` | Node 主版本变化，拒绝复用；核查并为新 Node 准备新的部署根目录，不改写已发布依赖 |
| `DEPLOYMENT_UNVERIFIED` | 运行进程源码/工具摘要不符，报告失败并暂停自动恢复；不得用“HTTP 健康”代替版本验收 |

回滚时先在面板安全停止 YCA，再选择**已经准备且验证过**的旧 commit：

```powershell
& $node (Join-Path $cc 'scripts/Prepare-YcaRuntime.js') --root $deploy --select '<旧 commit 的完整 SHA>' --node $node
if ($LASTEXITCODE -ne 0) { throw '旧部署核验未通过，禁止启动' }
```

随后面板启动 YCA。选择旧版同样不停止进程、不恢复旧 session 快照；沿用当前会话与历史。若要回到首次接入前的旧启动方式，安全停止 YCA、退出 Supervisor，恢复备份配置/入口再启动，不删除 runtime、锁、隧道或会话。已发布副本依赖损坏时不自动重装运行中的目录，应核查后换新的部署根目录。

### 独立验收与证据边界

- 面板的运行源码 commit 必须等于准备结果；`deployment.state=verified`，`running.dirty=false`，`launched/target` commit 一致。摘要来自该 YCA 进程的 MCP 注册；与候选 `tools.sha256/count` 对比。旧进程不提供来源时显示 unknown/unverified，不冒充已部署。
- 在本机 MCP `tools/list` 中检查 `filesystem_read` 描述包含区外绝对路径文本/Skills 支持。实际读取工作目录外预先放好的无敏感信息 UTF-8 文本，核对完整内容、字节数和 SHA-256；确认原控制中心配置仍返回 `PROTECTED_PATH`。迁移后显式 `--control-root` 保留控制中心配置/状态/部署目录保护，不改变通用 PowerShell 的权限语义。
- 通过 ChatGPT **现有连接**重做上述 `filesystem_read` 样本，并查看新描述。必要时刷新定义；缓存问题与 YCA 部署版本分开判断，不能用本机成功替代 ChatGPT 端到端。人工确认按钮只记录用户已核对运行中这份工具摘要。
- 自动化回归使用临时远端仓库、真实 npm 准备、独立 HTTP YCA 和真实 MCP 客户端，覆盖 dirty 开发工作区保护、默认分支变化、重跑、失败/回滚、运行中准备、Supervisor 重建、固定版本恢复、显式切换及原数据目录复用。它不连接正式 tunnel、不调用模型；Issue #11 的正式切换和 ChatGPT 验收需在合并后单独执行。

- 页面的“可用”只覆盖显示的本地证据；ChatGPT 字段“未在此验证”表示本地面板不自动验证 ChatGPT，人工端到端验收结果另记于验收文档。进程、YCA 健康、活动任务、tunnel readiness、代理可达性、有限日志中的通信时间分别记录。缺证据/过期显示未知或降级，降级不自动解释为断线或启动失败。实测手动启动后 tunnel 已健康就绪但近期日志为空时显示“降级”；随后 ChatGPT 调用成功并产生 `forwarded-to-mcp`，通信证据更新为 `recent-local-evidence`，页面转为“可用”。
- 既有专用文件工具禁止读写 `.local/control-center`，并禁止写控制中心安装代码，避免通过文件写接口篡改后台入口；这不把已有真实 PowerShell 脚本能力变成系统沙箱。
- tunnel 通过现有状态文件与 `/healthz`、`/readyz`、`/api/status`、`/api/system` 检测；**不轮询 `runtimes status` 或 `doctor`**，不触发 MCP 工具、模型、账号登录或远端状态查询。官方 `/ui` 仅在核对当前 tunnel 身份后提供链接。
- YCA 本地诊断采用随机 token，启动时从环境接收并立即从环境删除，避免传给工具子进程；token 仅在受忽略的本地状态文件持久化，绝不进入页面/诊断。管理面拒绝浏览器 Origin。页面 API 使用同源、HttpOnly/SameSite cookie + CSRF，固定动作，不接受任意命令。
- PID、创建时间、可执行路径、启动标记与 YCA 实例认证共同校验归属。没有充分证据时只观察，不按进程名杀进程。Supervisor 先绑定固定端口，再读取状态；目录绑定记录禁止同一状态被其他端口并发管理。
- 期望运行/停止持久化。恢复默认关闭；启用后，仅对期望运行的已退出实例或连续三次健康失败且确认空闲的 YCA 恢复。延迟 2/5/10/30 秒，10 分钟最多五次，预算跨 Supervisor 重启保留；稳定十分钟才清空计数。超过上限暂停，手动“重试恢复”可清空预算。
- 活着的 tunnel 始终交给官方内部网络重试，不因断网、认证失败或请求空闲重启 YCA。长检查间隔（>15 秒）触发补检和 30 秒宽限；这不是系统休眠检测，不累计期间失败次数。
- 停止/重启前检查活动任务，需用户明确确认影响。YCA 使用受认证的停止接口排空接受入口并调用原有关闭流程，等待最多 15 秒确认退出；**诊断面失联/停止超时则暂停并报告，不降级成未经核验的强杀**。原生 tunnel stop 前复验 OS 身份，结束后再次检查退出。
- 只有本中心的旧锁可以在验证 PID 已退出、没有活的孤儿 Codex 进程后备份移开；历史任务交给既有 Bridge 标为 interrupted，不重放，不删除 session/history。旧部署锁、活的孤儿任务、未知归属需人工核查。
- 固定版本的 native connect 会重写生成式 profile。因此启动前备份，并拒绝任何会被丢弃的自定义 proxy/auth/transport 设置；不是通用后端管理器。其他工具同时直接操作同一官方 alias 不在本控制中心的串行锁内，部署后请统一使用面板。

## 登录自启与回滚

脚本支持 `Preview`/`Status` 及 Install/Enable/Disable/Uninstall；真实生命周期与登录启动已验收，测试任务最终已卸载，`allowStartupChanges=false`。以后需要安装时，经用户确认再将其设为 true 并重启面板，解锁自启开关（安装/启用/禁用）和卸载按钮。

```powershell
pwsh.exe -NoProfile -File tools/control-center/scripts/Startup.ps1 -Action Preview -Config .local/control-center/config.json
# 经用户确认后的操作：-Action Install / Enable / Disable / Uninstall
```

任务名 `YukiLink-ControlCenter-V0`。当前用户 Interactive/Limited，前台 wrapper 等待 Node 退出并传递退出码；已有经核验的手动面板则跟踪其生命周期。IgnoreNew、失败一分钟后重试、最多三次、无限运行时限、电池允许、不要求外网、不唤醒系统。同名其他配置拒绝覆盖。禁用/卸载只改变后续登录启动，不杀现有服务；卸载前在本地状态目录导出 XML。

**登录自启与服务自动恢复是两个开关。** 计划任务拉起 Control Center/Supervisor；`autoRecovery=false` 时，即使 YCA/tunnel 的持久化期望状态为 `running`，Supervisor 也只观察，不自动拉起已退出服务。实际重启/登录后两服务为 `running=false`、`retries=0`，用户手动“启动全部”后调用成功。因此不能将此次登录验收表述为关闭自动恢复时 YCA/tunnel 也会自动启动。

回滚：先关闭自动恢复并停止全部（必要时确认任务影响）；如安装过计划任务，Disable 或 Uninstall；退出控制中心后台；用保留的 `.local/start-yca.ps1` 和原官方 runtime 入口恢复旧部署。profile 备份在控制中心状态目录，若需恢复只恢复对应 alias 的 profile，不能覆盖其他 alias 的全局状态。保留 Bridge runtime 与所有会话；不要删除 `.local` 或 tunnel 状态目录来“重置”。更换面板端口时，先确认旧 Supervisor 已退出，再备份其 `binding.json`。

## 日志、诊断与验证

“复制诊断”包括版本、Supervisor/服务实例元数据、部署 commit 与核验状态、证据时间、期望状态、最近退出码、有限事件、运行中工具定义摘要/数量及人工确认记录。工具摘要由实际 YCA 进程从 MCP 注册经过内存 transport 的 `tools/list` 计算，不取 Supervisor 相邻源码，不触发工具调用；不会假装读取 ChatGPT 缓存。源码 commit/dirty 在进程启动时固定，文件随后被人为修改不会重标记内存中已加载的代码；启动前会重新核验部署副本。这是本机部署证据，不是防本机用户篡改的安全证明。

Supervisor 日志为 `<stateDir>/events.jsonl`，256 KiB 轮转保留一个 `.1`；页面最多 80 条。tunnel 日志仅读末尾 32 KiB、输出最多 12 条固定词汇的事件投影；不返回 URL、连接/请求标识、headers、命令、环境、脚本输出、模型文本、凭据。官方原始日志继续由原 runtime 管理，不由本面板删除或轮转。

```powershell
cd tools/control-center
npm.cmd test
cd ../codex-session-bridge
npm.cmd test
```

Control Center 测试使用临时目录、随机端口、模拟 native runtime 命令及独立真实 YCA。`CC_TEST_PWSH` 可指定已验证的 PowerShell 7 路径。详见 [验收记录](../../docs/control-center-acceptance.md)：隔离测试与已完成的真实待机、断网、登录及人工 ChatGPT 验收分开记录。断网事实来自用户操作，恢复轨迹来自 tunnel/Control Center；额外 Windows 网络事件查询被平台拦截，无独立 Event Log 网络证据。长期稳定性、计划任务实际失败重试耗尽、完整回滚及 Codex 账号/模型调用仍未验证。

# Yuki Link · Control Center V0

独立 Node Supervisor + 原生网页，固定支持本机已核实的 **HTTP YCA + tunnel-client 0.0.14 managed runtime**。不更改 MCP 传输，不管理其他插件，不增加 MCP 工具。先看 [baseline](../../docs/control-center-baseline.md)。

## 打开与本机配置

要求 Windows、Node 24+、PowerShell 7，以及相邻 Bridge 已安装的原有 MCP SDK。没有新增 npm 依赖。配置使用原生 `.exe` 绝对路径，拒绝把 `.cmd/.bat/.ps1` 当原生程序启动；PowerShell 脚本统一经 `pwsh.exe -File`。

本机配置准备在仓库 `.local/control-center/config.json`，并生成 `.local/control-center/Open-ControlCenter.cmd`。该入口查找同一面板或隐藏启动后台，再打开浏览器。配置/状态/凭据引用不提交 Git。其他机器以 `config.example.json` 为结构示例，所有路径应重新核对，不能直接运行示例。

```powershell
pwsh.exe -NoProfile -File tools/control-center/scripts/Open-ControlCenter.ps1 -Config .local/control-center/config.json
```

控制页默认 `http://127.0.0.1:7392`；YCA MCP 保持 7391，受限诊断面使用独立 7393，不由 tunnel 转发。正式启动授权前 `observeOnly=true`，只观察已有元数据和本地健康信息，启停/恢复被服务端拒绝。**此次未授权启动正式 YCA/tunnel，未修改计划任务或桌面快捷方式。**

正式部署步骤：用户确认 → 复验正式进程/活动任务 → 备份处理 baseline 的未知旧锁（不能当作控制中心自己的锁）→ 将本地 `observeOnly` 设为 false → 重启 Supervisor → 在面板启动全部。保持原 runtime、allowlist、Codex 绝对路径、tunnel alias/profile/密钥引用。`connect` 固定传现有 tunnel ID，禁止无 ID 创建；原生命令会读取已有凭据认证，需纳入正式部署授权。

## 状态与恢复

- 页面的“可用”只覆盖显示的本地证据；ChatGPT 始终“未在此验证”。进程、YCA 健康、活动任务、tunnel readiness、代理可达性、有限日志中的通信时间分别记录。缺证据/过期显示未知或降级，降级不自动解释为断线。
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

脚本先支持 `Preview`/`Status`；当前配置 `allowStartupChanges=false`。用户确认后才将其设为 true 并重启面板，解锁自启开关（安装/启用/禁用）和卸载按钮。

```powershell
pwsh.exe -NoProfile -File tools/control-center/scripts/Startup.ps1 -Action Preview -Config .local/control-center/config.json
# 经用户确认后的操作：-Action Install / Enable / Disable / Uninstall
```

任务名 `YukiLink-ControlCenter-V0`。当前用户 Interactive/Limited，前台 wrapper 等待 Node 退出并传递退出码；已有经核验的手动面板则跟踪其生命周期。IgnoreNew、失败一分钟后重试、最多三次、无限运行时限、电池允许、不要求外网、不唤醒系统。同名其他配置拒绝覆盖。禁用/卸载只改变后续登录启动，不杀现有服务；卸载前在本地状态目录导出 XML。

回滚：先关闭自动恢复并停止全部（必要时确认任务影响）；如安装过计划任务，Disable 或 Uninstall；退出控制中心后台；用保留的 `.local/start-yca.ps1` 和原官方 runtime 入口恢复旧部署。profile 备份在控制中心状态目录，若需恢复只恢复对应 alias 的 profile，不能覆盖其他 alias 的全局状态。保留 Bridge runtime 与所有会话；不要删除 `.local` 或 tunnel 状态目录来“重置”。更换面板端口时，先确认旧 Supervisor 已退出，再备份其 `binding.json`。

## 日志、诊断与验证

“复制诊断”包括版本、Supervisor/服务实例元数据、证据时间、期望状态、最近退出码、有限事件、工具定义摘要/数量及人工确认记录。工具摘要从实际 MCP 注册经过内存 transport 的 `tools/list` 计算，不触发工具调用；不会假装读取 ChatGPT 缓存。

Supervisor 日志为 `<stateDir>/events.jsonl`，256 KiB 轮转保留一个 `.1`；页面最多 80 条。tunnel 日志仅读末尾 32 KiB、输出最多 12 条固定词汇的事件投影；不返回 URL、连接/请求标识、headers、命令、环境、脚本输出、模型文本、凭据。官方原始日志继续由原 runtime 管理，不由本面板删除或轮转。

```powershell
cd tools/control-center
npm.cmd test
cd ../codex-session-bridge
npm.cmd test
```

Control Center 测试使用临时目录、随机端口、模拟 native runtime 命令及独立真实 YCA。`CC_TEST_PWSH` 可指定已验证的 PowerShell 7 路径。详见 [验收记录](../../docs/control-center-acceptance.md)，本地通过不能替代真实休眠、登录及 ChatGPT 端验收。

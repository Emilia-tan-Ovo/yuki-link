# Control Center V0 baseline

核查：2026-09-16 21:40–22:05（UTC+8）。仓库位于用户桌面的 `yuki-link`，分支 `codex/control-center`。未找到额外仓库 AGENTS.md；遵守任务提供的指令。已有票据、Bridge README、catalog 及测试修改保留，不纳入本次提交。

## 实际部署与唯一管理方式

**独立 HTTP YCA + 官方 tunnel managed runtime。** Supervisor 直接管理 YCA；通过官方 `runtimes connect/stop` 管理固定 alias `codex-session-bridge`。不另 spawn tunnel daemon，不启用 stdio 分支，不接管 Windows-MCP/cloudflared。

| 项目 | 本机证据 |
| --- | --- |
| YCA | `tools/codex-session-bridge`，package 0.2.0；`.local/start-yca.ps1` 使用独立 HTTP `127.0.0.1:7391/mcp`，cwd 为 Bridge 目录，runtime 为 `runtime/service`，允许目录为当前仓库。保留原 runtime 和 allowlist。 |
| Node | `D:\develop\Node.js\node.exe`，实测 v24.18.1。 |
| PowerShell | 本任务解析到 Codex bundled `pwsh.exe` 7.6.5；另外观察到 WindowsApps 7.6.6 进程。旧 launcher 未固定 pwsh，依赖启动者 PATH；新配置显式固定已验证的 7.6.5，避免登录环境漂移。 |
| Codex | 原 launcher 固定当前用户 LocalAppData 下 `OpenAI\Codex\bin\12219cbfbcbddde7\codex.exe`，复验 0.154.0-alpha.6.2。保留绝对路径修复；只验证版本，不声称账号或推理可用。 |
| tunnel | `D:\tools\openai-tunnel-client\v0.0.14\tunnel-client.exe`；`--version` 为 0.0.14，commit `0f870e50a973fa820d4c409000059e181e8d242b`。profile 为 Bridge `runtime/tunnel/codex-session-bridge.yaml`（JSON 编码）；MCP target 是上述 HTTP 地址。 |
| 原管理者 | YCA 由本地 PowerShell launcher 启动；tunnel 原生 managed runtime 的 process 模式管理。未发现相关计划任务；未证明存在 YCA 外部恢复器。 |
| 配置来源 | 原 launcher、tunnel profile、当前用户 `.local/state/tunnel-client/{aliases,processes}.yaml`。未直接打开或展示凭据文件；保留 `file:` 引用，不保存连接 ID 到 Git。基线命令的隐含认证行为见下文。 |
| 环境 | 身份/路径依赖 `USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`PATH`；观察到 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 名称，未输出值。`TUNNEL_CLIENT_STATE_DIR` 用于固定官方状态根；不依赖 Codex 任务临时环境。现有 tunnel key 来自 profile，不新增 key 环境变量。 |

## 当前状态与可观测边界

- 核查时 YCA 7391 未监听，无匹配 YCA/tunnel 进程。官方旧 PID 也未运行。YCA `bridge.lock` 存在，但其中 PID 已不存在；保留原文件，不自动清理未受管的旧锁。
- 0.0.14 help 与对应 commit 源码确认 `/healthz`、`/readyz`、`/ui`、`/api/status`、`/api/system`。旧动态健康端口拒绝连接，因此当前内容验收待正式启动；不能写成接口实测正常。
- 此版本 `/readyz` 是纯文本，HTTP 200 也可能写着 MCP auth-required/timeout；必须检查内容。控制面状态来自 `/api/system` 的 `proxy_health`，没有该字段就标未知，不以长轮询/无调用判定离线。未找到新版通用 components 路由的本机证据。
- 原生 `runtimes status` 返回 `remote_lookup_attempted=true`：这次 baseline 调用实际尝试了远端只读查询；之后核对源码确认会解析现有认证引用。**不把此命令作为本地轮询**，后续检测仅读本地元数据和 loopback 接口；正式 connect 使用原认证前另请用户确认。
- `doctor` 源码会读取配置、检查 HTTP MCP/OAuth、测试监听等，不作为常驻轮询。本次没有执行 doctor。

## 有证据的故障记录

| 时间（UTC+8） | 组件 / 动作 | 结果 |
| --- | --- | --- |
| 09-16 16:47:35（文件 mtime） | YCA / ready 日志 | 仅一行 ready，无带时间退出记录。 |
| 09-16 17:11、17:43 | tunnel controlplane / poll | HTTP timeout/backoff，无进程退出码。 |
| 09-16 17:44:10 | tunnel controlplane / poll | 日志记录 recovered。 |
| 09-16 18:48–18:49 | tunnel controlplane / poll | timeout、unexpected EOF、降低 poll timeout，随后 18:49:23 recovered。 |
| 本次核查 | YCA 与 tunnel / 本地观察 | 均未运行，退出时间与原因未知。 |

**根因未定位**。以上不证明 ChatGPT session 过期、休眠导致掉线或当前聊天端是否可用。

## 实现调整

1. 固定以上一种部署；原生 tunnel 命令仅用于显式启停。其配置重写行为按对应版本审查，操作前验证 profile/alias/目标一致并保留配置备份，不允许创建新 tunnel。
2. 额外 YCA 管理面绑定独立 loopback 端口，要求本地随机 token；不挂到被 tunnel 转发的 MCP 入口，不新增 MCP 工具。活动任务与优雅停止在该面处理。
3. Supervisor 默认期望停止、自动恢复关闭；正式部署授权前只运行独立临时配置/模拟进程。自启脚本先交付和验证生成内容，不安装计划任务或桌面入口。
4. 未受管进程只观察；不凭 PID 文件杀进程。受管实例使用 PID、创建时间、路径及实例认证联合校验。旧锁等未知归属冲突报告后等待人工处理。

参考：[官方指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[对应版本 runtime 源码](https://github.com/openai/tunnel-client/blob/0f870e50a973fa820d4c409000059e181e8d242b/pkg/codexplugin/manager.go)、[对应版本 health 实现](https://github.com/openai/tunnel-client/blob/0f870e50a973fa820d4c409000059e181e8d242b/pkg/runtimehealth/health.go)。新版网页描述不能替代上述版本和本机证据。

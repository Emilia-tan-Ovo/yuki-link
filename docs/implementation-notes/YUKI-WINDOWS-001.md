# YUKI-WINDOWS-001 Implementation Notes

## Context Plan

### Core
- GitHub #165：Yuki Windows 纳入 yuki-link 生命周期，自启动、断线恢复与真实 E2E 验收。
- tools/control-center/src/{config.js,main.js,supervisor.js,units.js,startup.js}
- tools/control-center/test/{supervisor.test.js,tunnel.test.js,yuki-windows.test.js}
- 当前本机 Windows MCP：127.0.0.1:8000/mcp，windows_mcp 4.0.3；现有独立计划任务 windows-mcp-server。
- 当前 yuki-windows tunnel profile：仅引用现有本地 profile，不读取、不复制凭据。

### Related
- tools/control-center/public：高级维护页 / services 投影。
- tools/control-center/README.md 与 docs/control-center-acceptance.md。
- docs/tickets/001-yuki-windows-baseline.md：可复现 upstream baseline 的历史建议。

### Non-core / Out of scope
- 不 fork / 修改 Windows-MCP 上游。
- 不扩展新的桌面控制工具。
- 不迁移或复制 tunnel API key。
- 不把 Control Center 重构成通用 service framework。
- 不声称本机健康等于 ChatGPT E2E；E2E 必须由现有 Yuki Windows connector 单独验证。

## 已观察事实与失效条件

- 2026-09-29：127.0.0.1:8000 由现有 Windows MCP 监听；MCP initialize 返回 serverInfo.name=windows-mcp, version=4.0.3。安装/更新 Windows-MCP、修改端口或 launcher 后需重新确认。
- 2026-09-29：独立 Scheduled Task windows-mcp-server 为 Running；迁移前它属于外部启动实例，Control Center 不得直接接管。
- 2026-09-29：%APPDATA%\tunnel-client\yuki-windows.yaml 存在，但没有 yuki-windows tunnel-client 进程；ChatGPT Yuki Windows connector 实测返回 “Tunnel-client has not been seen for 300 seconds”。重新启动 tunnel 或修改 profile 后需重验。
- 当前 tunnel-client 受支持基线为 0.0.15+a390c168...；升级 tunnel-client 后必须重新跑版本/profile 兼容验证。
- 当前 Windows-MCP Python 解释器位于 uv cache。该路径仅作为本机 deployment fact；uv cache 更新/清理后必须更新 config。历史 Ticket 001 的 reproducible baseline 仍作为 follow-up，不阻塞本票先复用现有安装。

## 设计

### 1. 生命周期拓扑
最小扩展为四个受管 unit：yca、tunnel、windowsMcp、windowsTunnel。windowsMcp 新增专用 WindowsMcpUnit；windowsTunnel 使用薄 ProfileTunnelUnit，直接以 --profile-file 运行现有 YAML，不迁移为 managed-runtime profile。Supervisor 只增加第二条依赖边：tunnel -> yca；windowsTunnel -> windowsMcp。不建立通用 service registry / plugin framework。

### 2. Windows MCP ownership
受管实例直接以配置中的绝对 Python 路径启动：python -m windows_mcp serve --transport streamable-http --host 127.0.0.1 --port <port>。
ownership 同时要求 OS 仅发现一个匹配 executable + exact markers 的进程、PID + creation time 与 Control Center 持久化 ownership 一致、端口不存在独立冲突。未持有 ownership 的现有 Scheduled Task 实例只能显示 OBSERVED_UNOWNED / PORT_CONFLICT，不得停止或“收编”。
迁移顺序：先验证新 release/config -> 明确停止旧 windows-mcp-server task 及旧进程 -> 由 Control Center 首次启动并建立 ownership -> 验证 local MCP -> 启动 windowsTunnel -> E2E -> 最后禁用旧 task 的自动触发。回滚反向执行。

### 3. 健康
高频 observation 不反复创建 MCP session：精确 owned process + 本地端口身份为快速本地健康前提；首次启动必须执行一次 MCP initialize 深检，验证 serverInfo.name=windows-mcp。深检结果及时间作为 evidence；不把 tunnel/ChatGPT 状态混进 local health。

### 4. 自动恢复
- windowsMcp 进程退出：沿用 Supervisor bounded retry/backoff。
- windowsTunnel 进程退出：同样恢复，但依赖 windowsMcp healthy。
- windowsTunnel 仍活着但 control-plane/communication 降级：不重启它，更不重启 Windows MCP；交给 tunnel-client 原生网络重连。
- ownership 不明、版本/profile 不兼容、端口冲突均 fail closed。

### 5. 自启动
继续只安装一个 YukiLink-ControlCenter-V0 登录任务。任务只拉起 Control Center；Control Center 根据 durable desired state，按依赖顺序恢复 windowsMcp 再恢复 windowsTunnel。不再保留第二套自动拉起 Windows MCP 的计划任务触发。

### 6. 配置与 secret
新增生产 config 只包含 Windows MCP Python 绝对路径/port，以及 yuki-windows tunnel-client bin、profile path、profile SHA-256、独立本地 stateDir、target。profile 内容、API key/代理值不写入仓库；ProfileTunnelUnit 不解析 profile 内容，只校验文件摘要并把原文件交给 native client。

### 7. 诊断证据层
独立显示 windowsMcp 的 process ownership / port / MCP startup probe；windowsTunnel 的 native live/ready / control-plane 与本地健康证据；ChatGPT E2E 仅通过 connector 实测记录，不从本机推断。profile SHA-256 变化视为需要人工复核，不自动继续。

## 写集
- tools/control-center/src/config.js
- tools/control-center/src/main.js
- tools/control-center/src/supervisor.js
- tools/control-center/src/units.js
- tools/control-center/src/windows-mcp-unit.js
- tools/control-center/src/profile-tunnel-unit.js
- tools/control-center/src/common.js
- tools/control-center/src/server.js
- tools/control-center/config.example.json
- tools/control-center/test/supervisor.test.js
- tools/control-center/test/yuki-windows.test.js
- tools/control-center/public/{index.html,app.js,services.html,services.js}
- tools/control-center/README.md
- docs/implementation-notes/YUKI-WINDOWS-001.md

## Acceptance
1. 单元/确定性测试覆盖 ownership、MCP startup probe、依赖恢复和 live tunnel 不因网络降级重启。
2. 迁移时旧 Scheduled Task 实例被识别为 unowned，不被自动终止。
3. Control Center 管理 local MCP + yuki-windows tunnel，desired=running 跨 Supervisor 重启恢复。
4. 安装单一登录自启任务并验证 Control Center 冷启动恢复链。
5. 真实 Yuki Windows connector 只读调用成功。
6. 人为停止受管 yuki-windows tunnel 后，bounded recovery 自动恢复，connector 再次成功。

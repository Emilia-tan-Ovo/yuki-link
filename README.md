# yuki-link

面向用户与 AI 助手的统一 MCP / Bridge 项目。以统一核心连接设备与生活服务，让同一项能力可以由不同设备或服务提供。

**当前状态（截至 2026-09-18）：统一核心与 provider 仍以项目骨架为主；独立前置工具 Yuki Computer Agent 已完成 A 阶段主线至 YCA-005，并已进入默认分支。常驻 YCA 本机运行版本、selected release 与远端默认分支已核对一致，后端工具摘要为 18 项。具体稳定性仍以各票据、Control Center 和真实端到端验收为准。**

YCA 当前已提供 PowerShell、文本/Skills 读取、文件/Git 操作、受管前台任务及 Codex 会话通信。**YCA → Codex 的正常开发权限尚未完成：YCA-006 仍待实施。** 2026-09-17 的真实 YCA 会话中，Codex 仓库读取命令被原生 policy 以 `blocked by policy` 拒绝；因此在 YCA-006 完成并通过真实读写/命令验收前，只能描述为“会话通信已打通”，不能描述为“希尔薇酱已能经 YCA 正常读写仓库并开发”。这不等同于用户直接打开 Codex 工作区时的独立权限状态。

Control Center 已提供受管 release 的 running / selected / remote 状态、版本准备、仅重启当前版本和显式更新并重启。2026-09-17 实际使用暴露过 Codex 动态安装路径、YCA 更新生命周期及 shutdown `STOP_TIMEOUT` 等问题；根因、修复和能力声明纠正见 [运行时与能力边界事故复盘](docs/incidents/2026-09-17-yca-runtime-and-capability.md)。
## 三者的区别

| 名称 | 定位 | 与本仓库的关系 |
| --- | --- | --- |
| Remote Desktop Commander | ChatGPT 中连接的外部插件（对话中称“官方插件”；本次未核验发行主体） | 不属于我们的源码，不复制到本仓库 |
| Yuki Windows 自定义 MCP | 现有自定义接入；已找到其 Windows-MCP 安装代码、启动入口和同名隧道配置文件 | 保持原位；未来通过 computer provider 接入。尚未发现独立源码 fork |
| yuki-link | 我们未来统一维护的项目 | 管理核心、能力契约、服务编排与 provider adapter |

## 目录

```text
core/
  mcp/                          MCP 对外入口
  bridge/                       能力发现、路由与调用生命周期
  contracts/                    核心与 provider 共用的最小契约
capabilities/
  alarm/                        闹钟能力与服务编排
  ride/                         出行能力与服务编排
  food/                         餐饮能力与服务编排
  expense/                      记账能力与服务编排
providers/
  computer/yuki-windows/         现有 Windows 接入的未来 adapter
  phone/community-mobile-mcp/    社区 mobile MCP 的未来接入位置
  services/                     不依赖特定设备的服务 provider
tests/                          后续契约与调用流程测试
docs/                           盘点、结构设计与本地 ticket
tools/codex-session-bridge/      独立前置工具：直接电脑操作与 Codex 会话通信
tools/control-center/            本地服务控制页与 Supervisor（正式部署待授权验收）
```

`computer`、`phone` 是设备 provider 分类；`alarm`、`ride`、`food`、`expense` 是 capability/service 分类。手机只是某种执行途径，不能决定能力的归属。

## 开始阅读

- [术语](CONTEXT.md)
- [本机盘点与证据边界](docs/inventory.md)
- [结构与依赖方向](docs/architecture.md)
- [Ticket 001：建立 Yuki Windows 可复现源码基线](docs/tickets/001-yuki-windows-baseline.md)
- [Yuki Computer Agent：安装、工具与实际验证边界](tools/codex-session-bridge/README.md)
- [Control Center V0：打开入口、恢复、自启与回滚](tools/control-center/README.md)
- [YCA-001：真实 PowerShell 短脚本闭环](docs/tickets/yuki-computer-agent/001-powershell-execution.md)

前置工具独立于 `core/` 和 `providers/`，沿用既有连接和 runtime；其交付不启动正式 yuki-link 基线票，也不表示统一核心已经实现。具体能力及尚未完成的验收以工具说明和对应票据为准。

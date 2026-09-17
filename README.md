# yuki-link

面向用户与 AI 助手的统一 MCP / Bridge 项目。以统一核心连接设备与生活服务，让同一项能力可以由不同设备或服务提供。

**当前状态：统一核心与 provider 仍是项目骨架；独立前置工具 Yuki Computer Agent 已有可运行的 MCP / Codex Bridge。** 前置工具位于 `tools/codex-session-bridge`，提供固定 PowerShell 查询、真实短脚本、专用文件/Git 工具及 Codex 会话通信。YCA-001 的本机回归与 ChatGPT 端验收已通过，待 PR 审阅与合并；正式 yuki-link 的首张基线票尚未启动。

YCA-005 当前候选源码增加 `task_start/task_status/task_output/task_stop`，用于前台非交互长任务；用法与生命周期限制见 [任务工具说明](tools/codex-session-bridge/README.md#自有前台任务yca-005)。候选本机验证、独立候选验收及合并后常驻工具验收分别记录，不表示常驻服务已升级。

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

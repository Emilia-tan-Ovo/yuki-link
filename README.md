# yuki-link

面向用户与 AI 助手的统一 MCP / Bridge 项目。以统一核心连接设备与生活服务，让同一项能力可以由不同设备或服务提供。

**当前状态：仅有项目骨架和设计文档，没有可运行的 MCP、Bridge 或 provider。** 尚未选择语言、框架、部署方式或社区 mobile MCP。

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
```

`computer`、`phone` 是设备 provider 分类；`alarm`、`ride`、`food`、`expense` 是 capability/service 分类。手机只是某种执行途径，不能决定能力的归属。

## 开始阅读

- [术语](CONTEXT.md)
- [本机盘点与证据边界](docs/inventory.md)
- [结构与依赖方向](docs/architecture.md)
- [Ticket 001：建立 Yuki Windows 可复现源码基线](docs/tickets/001-yuki-windows-baseline.md)

本轮仅在此目录内初始化文件与本地 Git。现有代码、启动方式、凭证及敏感配置保持原状；未安装依赖、启动服务、配置远程仓库或发布。

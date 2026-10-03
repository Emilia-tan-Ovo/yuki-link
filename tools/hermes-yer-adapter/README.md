# Hermes · YER 工程适配器

本包将 YER（Yuki Engineering Runtime）的受管工作项、公开过程、工程验证、当前/累计修改与 Review/Acceptance 投影到 Hermes。普通文件、shell、Git 工作继续使用 Hermes 原生工具。

**状态：候选实现与隔离 fixture 测试已完成；未安装到日常 Hermes，未完成真实 Hermes→YER→Sylvia→Review→Acceptance 验收。** 原 YCA/Harness 的运行入口、数据与诊断 UI 保留。此 README 是后续获准部署时的配置契约，不表示已完成部署。

## 包结构与权威

- `__init__.py` / `plugin.yaml`：Hermes Agent 插件，仅注册 `yer_list_tools` 与 `yer_call_tool`；加载插件不会启动 runtime 或模型。目录由 YER 提供精确 schema，调用受工程 allowlist 限制。
- `dashboard/plugin_api.py` / `dashboard/manifest.json`：Hermes backend 插件，复用宿主 `_require_token`、同源校验和只读请求合并；用户动作带有绑定宿主身份与 source 的 CSRF 凭证。
- `desktop/plugin.js`：仅使用公开 `@hermes/plugin-sdk` 和 React 的 ESM pane，默认关闭。由 Hermes 的 unified plugin loader 装载，不能把它直接当普通网页打开。
- `skills/yer-engineering/SKILL.md`：短路由说明；生命周期来自目标仓库同根 `.workflow/skills`，不在插件复制一套状态机。

代码对接依据为 HERMES-YCA-001 Notes 中的 Hermes checkout `eb7e8620324b32424c06218f6a28094df2e921f8`。宿主升级后需重新核对 SDK、backend 鉴权及插件加载契约。真实加载和 UI 点击仍需后续验收。

YER 工程入口位于 `tools/codex-session-bridge/src/engineering/main.js`。它复用现有 RuntimeStore、Harness journal、ExecutionOperations、WorkflowAgentLauncher、PathPolicy 与 OwnedTasks 小接口，不实例化完整 ComputerTools 或 Companion。不迁移 store，不允许两个 writer 打开同一 runtime。

## 后续启动与绑定配置

使用宿主已就绪的 Node 24+、Git、PowerShell 7，以及既有 Codex 可执行程序和登录。工程模型与工具能力仍按实际宿主 preflight 探测；本包不更改全局模型、权限或代理设置。

从 `tools/codex-session-bridge` 运行的参数示例：

```powershell
npm run start:yer -- --runtime 'C:\yer\fixture-runtime' --allow-cwd 'C:\work\example' --port 7394 --adapter-config 'C:\yer-control\adapter.json' --implementation-launch-authority 'C:\yer-control\implementation-policy.json' --review-launch-authority 'C:\yer-control\review-policy.json' --workflow-agent-authority 'C:\yer-control\workflow-policy.json' --execution-authority 'C:\yer-control\execution-policy.json'
```

所有路径应为已核对的绝对路径；示例值不能直接代表本机事实。adapter/policy 文件须位于工程可写 allowlist 外。各 policy 沿用现有 File*AuthoritySource schema，由受信部署流程提供；缺失、内容或 revision 变化均须重新核验，不能以模型提交的配置创建授权。`--harness-port` 可选启用旧诊断页，需单独端口并已有 `npm run build:ui` 产物。

adapter 配置示例（只覆盖 Sylvia，不写回全局默认）：

```json
{
  "schema_version": 1,
  "adapter_id": "hermes-yer",
  "sylvia_profile": {
    "model": "gpt-6-astra",
    "reasoning": "xhigh",
    "service_tier": "fast"
  }
}
```

YER 和受信 Hermes backend 使用部署阶段单独提供的 `YER_ADAPTER_TOKEN`，仅供 preview/confirm/control；不要放进仓库、prompt、工具参数或日志。YER 在创建子执行前从自身环境移除此变量。Hermes Agent 工具 facade 不读取该 token；后续部署应保证 token 仅注入受信 backend，不向普通 Agent/shell 环境传播。本票没有读取或配置任何真实凭据。

目标 Hermes profile 的 home（由宿主 `get_hermes_home()` 解析）内使用 `yer-engineering.json`：

```json
{
  "schema_version": 1,
  "endpoint": "http://127.0.0.1:7394",
  "source_id": "00000000-0000-0000-0000-000000000000",
  "connection_id": "local-engineering",
  "profile": "default",
  "token_env": "YER_ADAPTER_TOKEN"
}
```

`source_id` 必须替换为目标 runtime `/engineering/identity` 的实际 journal source，端口与 profile 也须实际核对。每次调用重读配置并检查 service、protocol 和 source；端口被其他进程占用、source 改变、配置过期均报错，不能自动改连另一个服务。HTTP 客户端直接连数值 `127.0.0.1`，不读取代理设置、不跟随 redirect；MCP 与 HTTP 共用同一个 owner。

## 正常调用与恢复

Emilia 按工具目录登记 Ticket、记录可验证 workflow、读取内容身份并提出 `propose_engineering_action`。pane 的“预览/确认”读取并绑定计划、Ticket/worktree、内容、policy、权限与 profile，再由受信 backend 提交。模型提供 `confirmed=true` 不产生授权。已有同工作项授权内的续发走原 `start_workflow_agent` 与生命周期门禁，无需再次确认；独立 scope 仍需新授权。

API 使用 `/engineering/tickets/{ticket_id}/...`；preview/confirm 不注册为 MCP 工具。控制与 stop 绑定真实工作项 revision/session/run。响应未知时先用原 request 查询 `get_engineering_operation`，不要换 ID 重发。工程验证使用先记 intent、再绑定实际 task receipt 的窄执行器；task epoch 失效返回 reconcile，不自动重跑。

pane 按 connection/profile/durable chat/source/Ticket 隔离缓存；project 来自绑定 Ticket。初次读取固定 high-water cursor，随后按 event ID 去重、按 cursor 补增量；断线不重建 run。SDK 未提供底层 AbortSignal 的请求重载，取消会丢弃当前有界请求结果并阻止下一页，实际 socket 由超时收尾。窗口缓存最多 1000 个事件并提示截断；完整历史仍在 YER。终态降频、只读请求由 backend 合并，不启动模型。

current diff 区分 HEAD→index、index→worktree、untracked；cumulative 为 Ticket fixed point→当前净内容及提交。旧 patch 随 HEAD/index/worktree 内容变化而过期。保护路径、binary/deleted/过大及缺口状态显式保留，不把关联 run 当作者。面板只展示公开事件；完整 DSH 执行后端仍为 unsupported。

## 定向验证

仓库根：

```powershell
node --test tools/hermes-yer-adapter/test/desktop.test.mjs
python -m unittest discover -s tools/hermes-yer-adapter/test -p test_adapter.py -v
```

Python fixture 使用项目内虚拟环境及 `test/requirements.txt`，不要求改变全局 Python。Desktop 测试为公开 SDK mock + React SSR/cursor/cancellation；不等于 Hermes 实际 UI 验收。

`tools/codex-session-bridge` 内：

```powershell
npm run typecheck
node --test test/engineering-runtime.test.js test/engineering-changes.test.js
```

runtime fixture 使用假模型 executor 与真实隔离 store/journal/loopback MCP、PowerShell 任务；`test/ipc_probe.py` 在不可用代理环境下连接真实 fixture HTTP/MCP。完整结果和已知基线失败见 [Implementation Handoff](../../docs/implementation-notes/HERMES-YCA-001.md#implementation-handoff2026-10-04)。

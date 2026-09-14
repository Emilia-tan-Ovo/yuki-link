# Codex Session Bridge

独立的前置开发工具，不属于 Emilia Link 正式 ticket，也不依赖 `core/` 或 `providers/`。

Bridge 只传输 prompt、管理 session/run、返回事件与回复。它不理解或编排 Skills；调用方可以直接在 prompt 中写 `$pair-with-docs`、`$implement` 等指令。会话由本工具新建并管理，不接管 Codex 桌面中正在运行的任务。

## 本机启动

要求 Node.js 24+、可执行的 Codex CLI，以及 CLI 自己管理的既有登录。已验证 CLI `0.154.0-alpha.6.2`。Bridge 不读取、复制或保存 Codex 凭据。

在本目录运行（Windows 使用 PowerShell 7）：

```powershell
npm.cmd ci --ignore-scripts
node src/main.js --transport http --allow-cwd 'C:\Users\KQ_Sh\Desktop\yuki-link'
```

HTTP 只绑定 `127.0.0.1`，默认 MCP 地址 `http://127.0.0.1:7391/mcp`，健康检查 `/healthz`。不监听局域网地址。仅信任本机调用方；远程接入必须由单独授权的 tunnel 保护。Host/Origin 校验阻止普通浏览器跨站请求和 DNS rebinding，不替代身份认证。

可重复传入 `--allow-cwd` 添加管理员允许的工作目录。路径会取真实路径再校验，包含子目录，拒绝越界和指向允许目录之外的 junction/symlink。远端工具没有修改 allowlist、执行任意命令或传入 CLI flags 的能力。

其他本地启动参数：`--port`、`--runtime`（绝对路径）、`--codex-bin`（Codex 可执行文件路径）。未指定 allowlist 时拒绝启动。`--help` 查看参数。

本地进程型 MCP 客户端也可使用 stdio，按各客户端 JSON 配置的 command/args 方式提供：

```json
{
  "command": "node",
  "args": [
    "C:\\Users\\KQ_Sh\\Desktop\\yuki-link\\tools\\codex-session-bridge\\src\\main.js",
    "--transport", "stdio",
    "--allow-cwd", "C:\\Users\\KQ_Sh\\Desktop\\yuki-link"
  ]
}
```

以上是参数示例，不会修改现有 Codex/MCP 配置。stdio 的 stdout 专用于 MCP，诊断写 stderr。stdio 客户端关闭 stdin 时 Bridge 会停止自有运行；需要调用方断开后继续执行时，使用独立常驻的 HTTP 服务。

## 工具

| 工具 | 主要输入 | 返回 |
| --- | --- | --- |
| `codex_list_models` | `refresh?` | 本机模型、各自 reasoning 档位、查询时间 |
| `codex_start_session` | `request_id, cwd, prompt, sender?, model?, reasoning?, timeout_ms?` | `session_id, run_id, status, model, reasoning, deduplicated` |
| `codex_send_message` | `request_id, session_id, prompt, sender?, model?, reasoning?, timeout_ms?` | 同上 |
| `codex_get_status` | `session_id? / run_id?`，至少一个 | session、选定 run、当前 session 状态 |
| `codex_get_output` | `run_id, cursor?, limit?` | 事件、`next_cursor`、`has_more`、最终回复 |
| `codex_stop_session` | `session_id` | 停止进度，需继续查状态 |

首次创建默认 `gpt-6-astra / high`。模型目录来自当前 `codex app-server model/list`，含分页，缓存五分钟，可显式刷新；目录查询失败不猜测、不静默降级。新增模型无需修改 session 逻辑。

后续消息未指定的 model/reasoning 字段分别继承 session。只指定新 model 时 reasoning 仍继承原值；组合不支持就明确报错。每个 run 记录本轮传给 CLI 的配置；session 在 Codex 返回 thread ID 后更新配置。`config_source` 明确标注为 CLI 显式参数，并非通过模型自述推断的后端身份。

`start/send` 校验并持久化后立即返回，不等待模型生成。能力目录过期时可能先花数秒刷新，超时则报 `CAPABILITY_UNAVAILABLE`。同一 session 最多一个 active run；并发提交不同请求返回 `SESSION_BUSY`，不会暗中排队。

客户端用相同 `request_id` 和完全相同参数重试，得到原来的 `run_id`；修改参数复用 ID 则报 `REQUEST_ID_CONFLICT`。幂等范围是整个 runtime，同一消息的默认参数“省略”与“显式传入”不视为相同请求。新一轮消息必须换 ID。HTTP 连接断开不会取消 run。

`get_output` 的 cursor 从 0 开始，代表该 run 已读取的事件数。保留 `next_cursor`，`has_more=true` 时继续翻页。不要因一次空结果而判定结束，结合状态轮询。失败也可以读取已生成内容。

run 状态：

```text
queued → running → completed / failed
queued → stopped
running → stopping → stopped / timed_out / failed
进程异常退出后重启 → interrupted
```

`stopping` 仍占用会话；只有自有进程树终止并收到退出通知，才释放锁。stop 保留会话，不删除历史，也不回滚模型已经产生的操作。

## 持久化和恢复

```text
runtime/                  # 已由仓库 .gitignore 排除
  bridge.lock             # 单个 Bridge 写入者
  sessions.json           # session/run 元数据、request_id 幂等映射
  runs/<run-id>.jsonl      # 发送消息、Codex 事件、stderr、运行状态
```

元数据写入临时文件并原子替换；事件逐条追加。接收请求时若追加或保存失败，回滚内存中的请求映射和会话锁，返回 `PERSISTENCE_FAILED`，不启动进程；可能留下的无引用日志只供排查，不会执行。

正常停止后可直接重启。异常退出若留下 `bridge.lock`，启动会保守报错：需先核实 Bridge 和 run 进程都已停止，再把锁文件移开，不能自动抢占旧锁。随后恢复不会重发未完成请求，而是标记 `interrupted`，防止重复副作用。若记录的旧 PID 仍存活，仍会要求人工核实，不杀死可能已经被复用的 PID。损坏的完整日志或无法解释的锁会保留并报错，不静默重置。单次崩溃留下的半行 JSONL 尾部会被修复。

事件保留发送者标签（不是身份认证）、公开消息、模型配置与生命周期信息。已做常见 key/token 格式脱敏，但不能识别所有秘密：不要发送凭据或敏感配置；日志有完整会话内容，保存在本机，未加密，也不自动过期。

默认单次运行超时 5 分钟，可在 1 秒到 30 分钟内指定。prompt 上限 128 KiB；单行进程输出上限 2 MiB；单次事件日志上限约 16 MiB；超限会停止运行并报错。MVP 使用文件和内存，不适合长期大量并发；请定期在服务停止后归档 runtime。

## 执行与权限边界

所有子进程使用 `spawn(executable, args, { shell: false, windowsHide: true })`。完整 prompt 只经 UTF-8 stdin 发送，不作为命令参数拼接。stdout JSONL 和 stderr 分开解析，支持跨 chunk 的中文字符。resume 始终使用已保存的 Codex thread ID，不使用 `--last`。

当前只读 MVP 固定 `read-only` sandbox 和 `never` approval；不提供远端提权开关。使用仅对本次进程生效的 `--ignore-user-config`，并关闭 apps/plugins/hooks/browser/computer 工具，避免继承现有个人 MCP/外部写入能力。CLI 仍自行使用原登录，项目说明和 Skills 的发现由 Codex 负责。Bridge 不修改全局配置。正式开发权限与交互批准转发尚未实现；当前“通信成功”不等于整套 implement 工作流已验收。

Windows 停止只对 Bridge 持有的 ChildProcess 使用 `taskkill.exe /PID <pid> /T /F` 参数数组，不接受调用方 PID，不按进程名批量结束。其他平台使用自有进程组，尚未在本项目进行平台实测。

## 本地验证

```powershell
npm.cmd test
npm.cmd run test:live
```

常规测试不调用模型，包含真实 MCP HTTP 客户端、真实 Node 子进程 UTF-8 管道与 Windows 进程树终止。`test:live` 是显式联网验收，会使用 CLI 当前登录和模型额度：Astra high 首轮 → 原 thread 续聊 → 显式 Sol low 切换，验证含中文/引号/Windows 路径的原样回显、会话记忆、HTTP 重连和幂等。

真实验收报告保存在 `runtime/live-<timestamp>/acceptance.json`；不会提交实际会话记录。此次初始本机验收三轮均成功，使用同一个 Codex thread。这不表示每个 reasoning 档位都已实际请求过。

## 独立 tunnel 接入

保留现有 Yuki Windows tunnel/profile。新建独立 tunnel 和 ChatGPT connector，目标为 `http://127.0.0.1:7391/mcp`。已核验本机 `tunnel-client v0.0.14` 支持该 HTTP 入口；不要把新 daemon 接到旧 tunnel 的同一个 main channel。

需要用户提供新 tunnel ID、runtime key 的本机文件或环境变量引用，并授权 tunnel-client 使用该引用；不在聊天、仓库或 Bridge 日志中粘贴 key。仅完成本地测试不能算 ChatGPT 全链路验收。最终需要 tunnel ready，并由艾米莉亚碳在 ChatGPT 实际完成 start → get_output → send → get_output。

参考：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[App Server](https://learn.chatgpt.com/docs/app-server)、[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)、[Tunnel 接入](https://github.com/openai/tunnel-client/blob/master/docs/enterprise-customer-onboarding.md)。

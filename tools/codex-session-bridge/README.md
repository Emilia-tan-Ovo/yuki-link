# Yuki Computer Agent

独立的前置开发工具，不属于 yuki-link 正式 ticket，也不依赖 `core/` 或 `providers/`。

保留 `tools/codex-session-bridge` 目录，避免迁移已有 session/runtime。Computer Agent 直接提供固定 PowerShell 查询、真实短脚本及专用文件/Git 工具；Codex 模块只传输 prompt、管理 session/run、返回事件与回复。两条路径互不依赖：Codex 不可用不会阻止电脑工具启动。它不编排 Skills；调用方可在 prompt 中写 `$pair-with-docs`、`$implement`。会话由本工具新建并管理，不接管 Codex 桌面中正在运行的任务。

## 本机启动

要求 Node.js 24+；电脑查询使用 PowerShell 7、Git，真实脚本入口要求 PowerShell 7.4+ 的原生命令错误语义，已在独立服务进程验证 7.6.5。Codex 功能另外需要可执行的 CLI 及其既有登录，历史验证 CLI 为 `0.154.0-alpha.6.2`。Agent 不读取、复制或保存 Codex 凭据。

在本目录运行（Windows 使用 PowerShell 7）：

```powershell
npm.cmd ci --ignore-scripts
node src/main.js --transport http --allow-cwd 'C:\projects\yuki-link'
```

HTTP 只绑定 `127.0.0.1`，默认 MCP 地址 `http://127.0.0.1:7391/mcp`，健康检查 `/healthz`。不监听局域网地址。仅信任本机调用方；远程接入必须由单独授权的 tunnel 保护。Host/Origin 校验阻止普通浏览器跨站请求和 DNS rebinding，不替代身份认证。

可重复传入 `--allow-cwd` 添加管理员允许的工作目录。路径会取真实路径再校验，包含子目录，拒绝越界和 junction/symlink。脚本入口仍校验 cwd，但这不是脚本的访问沙箱：脚本实际读写、原生命令和外部访问受运行账号与系统权限影响。工具不提供任意 CLI flags 或提权开关，不增加额外批准机制。

`--allow-cwd` 同时限定 Codex 工作目录和文件写入范围。`--read-root` 可重复添加额外只读目录，用于目录列举、Git 查询和直接 PowerShell cwd 校验。`filesystem_read` 可读取任务明确指定的区外普通文本，仍受下文保护规则约束；其他入口范围不随之扩大。其他本地参数：`--port`、`--runtime`（绝对路径）、`--codex-bin`、`--pwsh-bin`。未指定 allowlist 时拒绝启动。`--help` 查看参数。

本地进程型 MCP 客户端也可使用 stdio，按各客户端 JSON 配置的 command/args 方式提供：

```json
{
  "command": "node",
  "args": [
    "C:\\projects\\yuki-link\\tools\\codex-session-bridge\\src\\main.js",
    "--transport", "stdio",
    "--allow-cwd", "C:\\projects\\yuki-link"
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
| `powershell` | `cwd, query, timeout_ms?` | `operation_id, exit_code, stdout, stderr, data` |
| `powershell_execute` | `cwd, script, timeout_ms?` | 执行结果；失败时位于 `error.details.result`，包含部分输出及终止信息 |
| `filesystem_list` | `path, cursor?, limit?` | 分页普通文件/目录，隐藏受保护项 |
| `filesystem_read` | `path` | UTF-8 内容、字节数、SHA-256 |
| `filesystem_write` | `path, content, expected_sha256?` | 创建或按原内容哈希更新 |
| `filesystem_move` | `source, destination, expected_sha256` | 同卷普通文件移动，不覆盖目标 |
| `git_status` | `cwd` | porcelain 状态输出 |
| `git_diff` | `cwd, path, staged?` | 单个允许文件的 diff |

### 直接电脑工具边界

`powershell` 的 `query` 当前只支持 `version`、`location`、`system`、`processes` 四种只读查询。它直接启动 PowerShell 7，不经过 Codex；固定 `.ps1` 接收 UTF-8 JSON stdin，不接受任意脚本、CMD 或动态表达式。查询最长 30 秒、输出总量 1 MiB、并发最多四个。`processes` 只返回前 200 个进程的名称/ID/资源用量，不返回命令行或环境变量。

`powershell_execute` 是独立的可写、非幂等工具，可能产生破坏性操作及访问外部环境。`script` 必填且非空白，不接受 `query` 或额外输入字段。`cwd` 为现有允许目录，单独作为进程工作目录；原样脚本文本通过 UTF-8 JSON stdin 送入固定入口，整体解析执行，不拼入命令行。保留 LF/CRLF、中文、单双引号及多行语法。仅支持短时非交互调用；stdin 已被请求消费，不能使用交互提示，也不能依赖用户脚本文件的 `$PSScriptRoot`。实际进程使用 `-NoProfile -NonInteractive`，不修改全局 PowerShell 配置。

| 预算 | 值 |
| --- | --- |
| 脚本默认执行时长 | 30,000 ms |
| 固定查询默认执行时长 | 10,000 ms |
| 两入口可设执行时长 | 1,000～30,000 ms |
| 脚本文本 | 最多 128 KiB UTF-8 字节；HTTP 整体请求仍受 1 MiB 限制 |
| 输出 | stdout、stderr 合计最多 1 MiB 原始字节 |
| 并发 | 脚本、查询及 Git 执行共享 4 个自有执行名额；繁忙时报错，不排队 |
| 终止收尾 | 触发终止后合计最多 5 秒，包含终止操作及管道收齐，不叠加等待 |

这些是执行和收尾预算，不是端到端网络延迟保证。A1 不提供运行中查询或主动停止接口；长任务管理留给 YCA-005。停止不回滚已经发生的文件或外部副作用。

### 脚本示例与退出语义

下面是 `powershell_execute` 的 JSON 输入示例。cwd 必须已经存在；脚本在其中创建唯一验收目录，创建、修改并读取中文文件：

```json
{
  "cwd": "C:\\projects\\yuki-link",
  "script": "$dir = Join-Path (Get-Location) ('A1 验收 ' + [guid]::NewGuid().ToString('N'))\nNew-Item -ItemType Directory -Path $dir | Out-Null\n$file = Join-Path $dir '中文 文件.txt'\n$text = '中文 \"双引号\" 与 ''单引号'''\nSet-Content -LiteralPath $file -Value $text -Encoding utf8 -NoNewline\nAdd-Content -LiteralPath $file -Value '：已修改' -Encoding utf8 -NoNewline\nGet-Content -LiteralPath $file -Raw -Encoding utf8",
  "timeout_ms": 30000
}
```

脚本入口默认设置 `ErrorActionPreference=Stop` 和 `PSNativeCommandUseErrorActionPreference=true`。未处理的 PowerShell/解析错误退出 1；显式 `exit N` 和未处理的原生命令非零退出保留 N。脚本捕获并处理错误后可以正常结束；不根据 stderr 非空、历史错误记录或陈旧 LASTEXITCODE 判失败。

例如 `[Console]::Error.WriteLine('诊断'); exit 0` 成功；`[Console]::Out.WriteLine('OUT'); [Console]::Error.WriteLine('ERR'); exit 7` 报失败但保留两路输出和退出码 7。需要接受某个原生命令的特定非零码时，在局部显式覆盖策略并自行判断，例如 Git diff 的 1 表示存在差异：

```powershell
& {
    $PSNativeCommandUseErrorActionPreference = $false
    git.exe diff --quiet
    if ($LASTEXITCODE -gt 1) { throw "git diff failed: $LASTEXITCODE" }
    if ($LASTEXITCODE -eq 1) { '存在差异' }
}
```

这里只表示脚本按其有效错误策略正常结束，不保证每条命令都成功。显式改用 `-ErrorAction Continue` 或其他策略时，由脚本负责后续判断。UTF-8 文本按两条操作系统输出流返回，不提供 PowerShell 六类流的独立结构；任意旧原生程序自选编码或二进制输出不保证无损解码。

### 失败、部分输出与结束情况

成功结果直接包含执行对象；失败沿用 `isError:true` 及 `error.code/message/details`，完整执行对象在 `error.details.result`。text content 与 structuredContent 携带同样的 JSON。非零退出的既有 `details.exit_code/stderr` 字段保持可读。参数或开始审计失败等执行前错误没有执行对象；尝试启动失败则明确返回未启动、null 退出码与空输出。

| 结果字段 | 含义 |
| --- | --- |
| `operation_id`, `stdout`, `stderr`, `exit_code`, `signal` | 本次标识、独立两路输出、实际 pwsh 退出码或 null、实际信号；不承诺跨流总顺序 |
| `completion_reason` | `exited / timeout / output_limit / spawn_error / stdin_error / stream_error / shutdown`；超时/超限原因不会被停止造成的退出码覆盖 |
| `process_state` | `not_started / running / exited`；只有观察到根进程退出才报告 exited |
| `timeout_ms` | 此次采用的执行预算 |
| `termination.requested`, `termination.tree_kill` | 是否请求停止；`not_requested / succeeded / failed / unconfirmed` 是自有树停止操作结果，与根进程退出分开报告；失败时附错误信息 |
| `output` | `limit_bytes`、两流保留字节数、各流 `*_truncated`、`incomplete`、`redacted`；字节数按脱敏前计算 |
| `audit` | `recorded / failed`；结束审计失败不覆盖已观察输出和退出状态 |

`QUERY_TIMEOUT`、`OUTPUT_LIMIT` 会尽可能保留预算内的两流前缀；跨上限的 chunk 不整块丢弃，UTF-8 边界截断不制造乱码。超时表示中断，不一定发生输出截断。停止失败或尚未确认时如实返回，仍运行的根进程继续占用共享名额。根进程退出但后代未关闭管道时，也会有限期返回不完整输出，不能将此视作整棵进程树已结束。只读 Git 的敏感内容拒绝仍不附回被拒绝正文。

后续服务关闭时，会对已返回结果但仍存活的自有根进程单独尝试一次停止，最多收尾 5 秒；仍不能确认停止则报告 `STOP_FAILED`。这不延长先前调用的预算，也不改写已返回的结果。

输出沿用常见凭据格式脱敏；`redacted=true` 表示返回文本经过改写，不能把它当作逐字原始输出。审计只记录必要元数据，不写脚本文本、输出正文或环境。HTTP 断开不会自动重放脚本，operation_id 不提供去重或历史查询。未收到结果时先核对实际文件等事实，不无条件重发；工具的非幂等注解不是 exactly-once 保证。

### 专用文件与 Git 工具

`filesystem_read` 接受任务明确指定的绝对本地文件路径，可超出 `readRoots` 读取普通 UTF-8 文本、Markdown 和源码，不要求扩展名白名单。允许 `.agents/skills/**`、`.codex/skills/**` 下的正文与辅助文本（不限 `SKILL.md`），仅豁免对应配置目录组件；其他敏感组件（例如 Skill 内的 `.env`、`.ssh`、`credentials`）、实际 runtime 与本安装的 `.local/control-center` 配置仍拒绝。保留 junction/symlink、硬链接、UNC/device、ADS、Windows 模糊名称和 canonical/8.3 路径校验。内容的常见凭据模式仍返回 `SENSITIVE_CONTENT`，但不能识别所有秘密；调用方仍应按任务授权选择资料。

读取结果保持 `path/content/bytes/sha256/encoding`：`path` 为 canonical 路径，`encoding` 为 `utf-8`，BOM、中文、LF/CRLF 原样保留；`bytes` 与 SHA-256 对应完整原始字节。空文件可读；超过 256 KiB 返回 `FILE_TOO_LARGE`，不分页、不成功截断。读取至多使用 `256 KiB + 1` 字节缓冲，并循环处理操作系统短读；文件在元数据检查后增长越界也会拒绝。该行为不承诺并发快照。非法 UTF-8 或 NUL 字节返回 `NOT_UTF8_TEXT`，目录返回 `NOT_A_FILE`，缺失文件返回 `PATH_NOT_FOUND`。

创建、更新及单文件移动仍限原写入范围和 256 KiB UTF-8 普通文件；父目录必须存在。写入另外保护 Agent 自身安装目录及 `AGENTS.md` / `CLAUDE.md`。更改现有内容必须带当前 `expected_sha256`：缺失哈希返回 `FILE_EXISTS`，旧哈希或带哈希时目标已消失返回 `CONTENT_CONFLICT`，拒绝后保留当前内容。**兼容例外**：请求内容与当前完整字节相同，返回 `changed:false`，即使没有哈希或哈希已过期也不写入；这不表示旧哈希校验通过。更新含再次核对，但不是原子 CAS。

Skill 读取示例（换成任务指定的真实本机位置）：

```json
{"path":"C:\\Users\\example\\.agents\\skills\\implement\\SKILL.md"}
```

以上参数交给 `filesystem_read`。读取 Skill 正文不执行 Skill，也不授予 Skill 写入权限。目录列举、Git、PowerShell cwd、写入与移动保持各自原有范围；这不是对通用 PowerShell 脚本实际访问能力的限制。PDF/Word 正文解析、图片理解及目录/二进制管理不由 YCA-002 交付。

专用移动仅支持同卷且支持硬链接的文件系统，以先建立新文件名、再移除旧文件名实现不覆盖目标；中断可能留下两个名字，内容仍在，但需要本机恢复。专用文件入口尚不提供目录移动、删除、创建链接或系统配置操作。其路径检查不约束通用脚本，也不是抵御其他本机进程并发篡改路径的操作系统沙箱。

Git 只提供 status 和单文件 diff；仓库根也必须在允许读取目录中。禁用外部 diff、textconv、fsmonitor、pager、clean/process 过滤器和子模块检查，不接受任意 Git 参数。过滤器仅枚举配置键名以设置本次禁用项，不读取配置值。没有 commit/push 工具。

电脑操作记录到 `computer-audit.jsonl`，只保存操作、时间、结果和字节数等元数据，不记录文件内容、子进程输出、环境变量或凭据。固定查询与短脚本同步返回，Codex 仍使用异步 run。

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
  computer-audit.jsonl    # 电脑工具操作元数据
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

常规测试不调用模型，包含真实 MCP HTTP/stdio 客户端、PowerShell 短脚本文件闭环、退出语义、部分输出、Windows 自有进程树终止、最小故障注入、断线不重放、临时文件/Git 仓库及既有 Bridge 回归。独立 stdio 服务用无效 `--codex-bin` 验证直接能力不依赖 Codex。`test:live` 是另外的显式联网验收，会使用 CLI 当前登录和模型额度；YCA-001 不需要运行它。

YCA-002 的 `test/text.test.js` 使用真实 HTTP/MCP 和临时文件，封堵并计数 model start/send/executor，验证文件调用为零模型调用。覆盖区外/Skill 文本、BOM/换行、短读/增长/大小边界、冲突/no-op、敏感路径/内容、链接及其他入口不扩围。Windows 测试报告实际可用的 8.3 别名数量。可在当前 PowerShell 进程设置 `YCA_TEST_SKILL` 为获准读取的真实 `.agents/skills/.../SKILL.md` 或 `.codex/skills/.../SKILL.md`，再运行 `node --test test/text.test.js`，只读取并核对原字节、哈希及未修改状态；未指定时该真实文件用例跳过，其他用例使用夹具。仓库没有 typecheck 脚本，使用 `node --check` 检查 JavaScript 语法。

本票本机测试不代表已部署，也不替代 ChatGPT 经现有连接直接读取区外资料及更新样本文本的验收。该端到端验收尚待执行，见 [YCA-002](../../docs/tickets/yuki-computer-agent/002-text-and-skills.md)。

YCA-001 本机回归 39/39 通过；2026-09-16 用户确认 ChatGPT → Yuki Computer Agent → PowerShell 7 的真实验收通过，全程未经过 Codex。中文/引号/多行文件闭环、两流与退出语义、超时/超限部分输出及四种旧查询均通过，详见 [YCA-001 验收记录](../../docs/tickets/yuki-computer-agent/001-powershell-execution.md#本地实现与验收状态)。输出超限用例的根进程已退出，但 `tree_kill=unconfirmed`，保留这一未确认状态；超时用例则确认 `tree_kill=succeeded`。本机结果与用户提供的 ChatGPT 验收证据分别记录。

真实验收报告保存在 `runtime/live-<timestamp>/acceptance.json`；不会提交实际会话记录。此次初始本机验收三轮均成功，使用同一个 Codex thread。这不表示每个 reasoning 档位都已实际请求过。

## 复用 Yuki Computer Agent tunnel

沿用用户已配置并命名为 **Yuki Computer Agent** 的 tunnel（连接 ID 从本地配置获取，不记录在仓库中）。本机目标 `http://127.0.0.1:7391/mcp`，客户端 `tunnel-client v0.0.14`。内部 runtime alias/profile 继续使用 `codex-session-bridge`；不创建新 tunnel/key，也不修改其他 Windows-MCP tunnel。

本机凭据引用由用户在本地配置，文档不记录实际存放路径，仅 tunnel-client 读取用于认证；Agent 不读取它，不把内容加入 prompt、日志或 Git。名称变化不会要求重新生成 key；到期、撤销或损坏时才需要处理凭据。

继续复用现有 **Yuki Computer Agent** tunnel 和 key。YCA-001 交付时，本机已暴露 14 个工具，但 ChatGPT 端插件刷新后仍只有旧 13 个；用户删除后重新安装插件，才加载到包含 `powershell_execute` 的完整清单。遇到同类情况应以实际工具清单和新对话调用为准，必要时重装 ChatGPT 端插件并选择原 tunnel，不重建 tunnel/key，不清空 runtime。

加载后应发现 14 个工具，其中 `powershell` 仍为固定查询，`powershell_execute` 为新脚本入口。通过 ChatGPT 实际创建、修改、读取唯一验收目录中的文件，再核对错误、超时/超限结果；A1 全程不调用 Codex 模型。tunnel ready、本机测试及工具发现不能单独替代 ChatGPT 脚本验收。YCA-001 本次实际验收已通过，Codex 协作验收属于独立后续安排。

参考：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[App Server](https://learn.chatgpt.com/docs/app-server)、[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)、[Tunnel 接入](https://github.com/openai/tunnel-client/blob/master/docs/enterprise-customer-onboarding.md)。

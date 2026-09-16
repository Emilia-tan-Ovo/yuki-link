# yuki-link · YCA-001 实现前设计

状态：**已确认 / ticket-design 完成**。统一审阅日期：2026-09-16。本文保留设计阶段结束时的事实与停止点；后续实施、提交及验收现状以[本地票据](001-powershell-execution.md#本地实现与验收状态)为准。

对应 [Issue #1](https://github.com/Emilia-tan-Ovo/yuki-link/issues/1)、[本地票据](001-powershell-execution.md)及[当前 Spec](../../specs/yuki-computer-agent.md)。设计主线已通过统一审阅，按 Q1=B、Q2=A、Q3=A、Q4=B 收敛，并回填本地票据 Implementation Notes。仅完成设计及文档回填，没有实施、提交、push、服务重启或远端更新。`ready-for-agent` 仅表示票据范围就绪；设计确认不代表实施授权，A1 验收未完成。

本文第 1～2 节保留设计调查时的资料及验证事实；第 3～7 节为按用户统一回复收敛的已确认设计。沿用已有探针证据，无需再次设计调查或审阅；实现修改后运行对应回归，本机测试与 ChatGPT 端验收分别记录。

## 1. 资料基线与差异

- 本地 HEAD 与远端 HEAD 均为 `da848dbb7cf16199803efa3508c161becbe6ef08`；本地当前分支为 `codex/YCA-001`，远端默认分支文件读取位置为 `codex/codex-session-bridge`。提交包含最新中性称呼与 yuki-link 命名调整。本轮未切换或创建分支。
- 本地 Spec 与远端当前分支文件一致，Git blob 为 `ea703b4223354e3303c96cc87309ff16a5821008`。
- Issue #1 正文仍有旧人物称呼、旧项目名称；其 Spec 链接固定在旧提交 `5dbc9621dcced32fa942d3be0ccc57dc3266cb60`。逐项对照后，差异为称呼更新；未发现影响 A1 范围、退出结果要求或验收标准的实质冲突。以当前本地/远端 Spec、当前票据与本轮命名要求为准，不复制旧称呼，不修改远端正文。
- 开始时有 8 个票据/索引文件的未提交修改。本票相对远端票据新增 GitHub Issue 链接；其他回填包括索引和依赖引用。全部保留，本轮不覆盖、提交或同步它们。
- 已依次读取完整 Issue（无评论）、本地票据、Spec、`CONTEXT.md`、`docs/architecture.md`、票据索引、根 README、工具 README、代码和测试。仓库及适用父目录未发现额外磁盘 `AGENTS.md`；遵循本轮提供的 AGENTS 指令。未发现独立 ADR 或其他工程规范文件。
- 已读取本机 ticket-design、context7-mcp 和 codebase-design Skill。另只读检查 implement Skill 的票据消费约定：未发现禁止 Markdown `Implementation Notes` 的解析格式；没有调用 implement。

## 2. 现有实现与本轮验证事实

| 位置 | 事实及对本票的影响 |
| --- | --- |
| `tools/codex-session-bridge/src/mcp.js` | 13 个工具；`powershell` 仅接受 `cwd, query, timeout_ms?`，标注只读/幂等。工具错误为 `isError:true`，JSON 放在 `structuredContent` 和 text content 中 |
| `src/computer/tools.js` | `powershell()` 校验四种 query；`execute()` 被 PowerShell 和 Git 查询共用。默认 10 秒、范围 1～30 秒、两路合计 1 MiB、并发最多 4 个 |
| `src/computer/query.ps1` | 固定 `.ps1` 通过 UTF-8 JSON stdin 收取 query；已有 UTF-8 控制台设置，不涉及 shell 拼接 |
| `src/process.js` | `spawnDirect()` 固定参数数组、`shell:false`、`windowsHide:true`；`stopProcessTree()` 只接收本服务持有的 ChildProcess，Windows 使用 `taskkill /PID /T /F`，自身等待最多 5 秒 |
| `src/computer/tools.js` | 非零退出错误只带退出码和 stderr，丢失 stdout；超时/超限错误不带结果。跨越输出上限的整个 chunk 被丢弃；终止失败被忽略，只等 `close`，可能长期不返回 |
| `src/main.js`、`src/http.js` | Codex 发现是惰性的；现有 HTTP/stdio 可直接调用电脑工具。HTTP 请求体上限 1 MiB；本票无需新增通信入口或改认证/连接 |
| `src/computer/paths.js` | 当前 cwd 使用现有目录校验和 read roots；这些检查只检查入口路径，不能约束任意脚本内的访问 |
| 审计 | `computer-audit.jsonl` 已记录开始、结束、operation ID 等；不记录脚本文本、输出、环境或凭据。结束审计写失败目前会丢失执行结果 |

本轮使用 Node `v24.18.1`、PowerShell `7.6.5`；本地已装 MCP SDK `1.30.0`、Zod `4.6.5`，未安装或升级依赖。

- `npm.cmd test`：**16/16 通过，0 跳过**，包含真实 MCP HTTP、固定 PowerShell 查询、文件/Git 查询、UTF-8 管道、自有进程树终止以及 Codex fake executor 回归，没有模型调用。
- 独立 PowerShell 探针共 15 个案例：中文/空格路径、单双引号、多行 here-string 和 emoji 原样落盘；两路输出成功；显式 `exit 7` 返回 7；`Write-Error`/`throw`/解析错误返回 1；原生进程非零可保留 9；处理过的错误可成功；原生 stderr 文本不致失败；非交互 `Read-Host` 报错；`return` 正常结束。
- 其中用真实 `node.exe` 输出独立 stdout/stderr 再退出 9，确认两路保留且退出码为 9。默认严格错误设置只存在于探针进程中，没有改全局 PowerShell 配置。
- 再用现有 `ComputerTools.execute()` 验证 3 个案例：`exit 7` 确实丢 stdout；超时为 `QUERY_TIMEOUT` 且 details 为空；超限为 `OUTPUT_LIMIT` 且 details 为空。这是现状复现，不是修复验证。
- 探针及原始结果位于 Git 已忽略的 `.local/yca001-design-zI3iLb/`。`probe.ps1` 中的 `WRAPPER_REACHED_END`/`CAUGHT:` 是诊断标记，不属于提议的生产输出。

探针没有经过现有 ChatGPT 连接，也没有在常驻服务进程中验证新路径。因此不能将以上证据标成 A1-AC1～6 已完成。当前服务/隧道未重启、迁移或变更；没有读取密钥。

## 3. 已确认：公开输入与脚本传递

**P1（Q1=B）**：保留 `powershell(cwd, query, timeout_ms?)`，新增 `powershell_execute(cwd, script, timeout_ms?)`。两个公开入口复用同一执行器、输出捕获、终止与错误处理，不复制生命周期代码。

| 输入 | 已确认契约 |
| --- | --- |
| `cwd` | 必填，绝对且已存在的目录，继续使用现有目录校验；通过 Node spawn 的 cwd 传递，不拼入脚本 |
| `query` | 原 `powershell` 的必填输入，`version/location/system/processes` 四值不变；新 `powershell_execute` 不接受此字段 |
| `script` | 新 `powershell_execute` 的必填、非空白 PowerShell 源文本；不增加到原查询工具，不采用 query/script 二选一结构。缺失、空白或传入 query 时执行前拒绝，不得先执行一部分 |
| `timeout_ms` | 沿用可选整数，默认和有效范围见 P4 |

脚本文本只判断空白与大小，不 trim、插值、重排换行或转义重写。支持 LF/CRLF；完整文本作为 JSON 字段用 UTF-8 stdin 送入一个固定脚本入口。继续使用 `pwsh.exe -NoLogo -NoProfile -NonInteractive -File <固定入口>`，参数数组加 `shell:false`，入口解析 JSON 后通过 `ScriptBlock.Create()` 整体解析和调用。避免 `-Command -` 逐条解析、命令行长度限制和第二层字符串转义；不生成含用户脚本的持久临时 `.ps1`。

固定查询仍走现有 `query.ps1` 并解析 `data`；脚本模式不把 stdout 当 JSON，不混入 Bridge 状态标记。脚本入口可新增一个很小的固定 `.ps1`，具体文件名留给实施。

脚本 stdin 已被请求信封消费并结束，不提供交互输入；本票不增加 `stdin`、任意 CLI flags 或环境变量覆盖字段。脚本为内存脚本块，不能依赖“用户脚本文件自身路径”的 `$PSScriptRoot` 语义；相对目标文件以 cwd 为基准。

原 `powershell` 保留四种查询的正常结果字段、`data` 及只读/幂等注解。新 `powershell_execute` 标注 `readOnlyHint=false`、`idempotentHint=false`、`destructiveHint=true`、`openWorldHint=true`，说明脚本可能写文件、调用原生命令及访问外部环境。不增加额外批准或隔离机制。

## 4. 已确认：PowerShell 与原生命令退出语义

**P2（Q2=A）**：仅脚本模式默认采用 `$ErrorActionPreference='Stop'` 与 `$PSNativeCommandUseErrorActionPreference=$true`。与严格自动化相符，避免中间步骤失败后最终输出掩盖失败；不启用额外 StrictMode，不改 profile 或全局配置。

| 脚本情况 | 已确认的可见结果 |
| --- | --- |
| 正常完成、仅写 stderr、正常 `return` | 实际 pwsh 退出 0；两路独立返回；stderr 非空不改变成功判断 |
| `exit N` | pwsh 按 N 退出；保留已有两路输出。独立探针确认 `exit` 不会被外层正常结尾覆盖 |
| 未处理的 PowerShell 错误或脚本解析错误 | 固定入口写入可理解的错误标识、消息及必要位置，退出 1；已有输出保留；整体解析失败时不执行前面的片段 |
| 未处理的原生命令非零 | 停止后续步骤；捕获 `NativeCommandExitException` 并让 pwsh 以该异常的 ExitCode 退出。例如原生 9 → pwsh 9，不能统一丢成 1 |
| 脚本内部 `try/catch` 已处理错误 | 正常完成可退出 0；不因 `$Error` 留有记录或陈旧 `$LASTEXITCODE` 再次判失败 |
| 脚本显式覆盖错误策略 | 尊重 PowerShell 语言行为。`-ErrorAction Continue` 或关闭原生错误偏好后，需要脚本自行检查并处理退出码；正常结束为 0，失败时显式 throw/exit |
| 启动失败、强制终止或尚未观察到退出 | 不凭上述语义合成进程退出码；Node 观察到什么就报告什么，没有可确认码为 null |

包装器只把定义好的错误策略映射为真实 pwsh 退出；Node 不根据 stderr 文本猜退出码，也不通过文本匹配识别原生错误类型。未被脚本处理的非零退出仍是工具错误。

Windows 工具中有“非零代表正常差异/部分成果”的命令；文档给出在局部关闭原生错误偏好、检查 `$LASTEXITCODE` 后再决定 throw/exit 的示例。这里的“成功”只表示脚本按其有效错误策略正常结束，不承诺脚本内部每条命令都成功。

UTF-8 控制台输入、输出及 `$OutputEncoding` 沿用现有设置。保证本票 PowerShell 文本样本；不承诺任意自选编码的旧原生程序或二进制 stdout 能无损变成 UTF-8，也不增建编码探测接口。

该决策依据已有本机探针及 [PowerShell 错误偏好文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.6)、[pwsh 退出语义文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.6)。已验证的 7.6.5 支持所需原生错误偏好；实施需验证实际服务选用的 pwsh，不静默在不支持该行为的版本上退回可能掩盖错误的模式。

## 5. 已确认：完整结果、限制与终止

**P3（Q3=A）**：保留现有 MCP 成功/错误信封。正常返回结果对象；已受理的执行失败仍 `isError:true`，在 `error.details.result` 中附同样的结果对象。保留已有 `error.code/message`，非零退出原有 `details.exit_code/stderr` 继续可读。text content 与 structuredContent 携带相同 JSON 信息，不要求调用方解析错误字符串，不为统一外观重构整套 MCP 包装器。

| 结果信息 | 已确认语义 |
| --- | --- |
| `operation_id`、`stdout`、`stderr`、`exit_code` | 保持现有字段；exit_code 是实测 pwsh 退出码或 null；两流保持各自顺序，不承诺跨流总顺序 |
| `completion_reason` | `exited / timeout / output_limit / spawn_error / stdin_error / stream_error / shutdown`；已发生的超时/超限不能被终止造成的非零退出覆盖 |
| `process_state`、`signal` | `not_started / exited / running / unknown`；`exited` 需观察到自有根进程退出。只有退出可确认但数字码不可得时仍使用 null，并保留实际 signal |
| `termination` | `requested`，`tree_kill: not_requested / succeeded / failed / unconfirmed`，以及必要的脱敏错误信息；tree_kill 只表示自有进程树终止操作结果，不等于全系统不存在脱离的后代 |
| `output` | 有效 `limit_bytes`、两流保留的原始字节计数、各流 `truncated`、`incomplete`；中断或未收齐管道时 incomplete 为 true；被丢弃的字节才标 truncated，超时本身不自动等于截断 |
| `output.redacted` | 是否被现有脱敏规则改写；保留字节计数按脱敏前计算，不把返回文本宣称为无条件逐字原始输出 |
| `audit` | `recorded / failed`；结束审计失败不覆盖已确认的退出与输出，随错误保留结果 |

未通过参数、cwd、可执行程序路径校验或开始审计落盘的请求，明确未启动，继续按现有错误返回，不伪造 operation 执行结果。真正尝试 spawn 后失败，结果为 `process_state=not_started`、exit_code=null、两流为空。区分执行失败与“未开始”，有副作用的执行结果不可因错误而重放。

错误码优先复用 `PROCESS_EXIT_FAILED`、`QUERY_TIMEOUT`、`OUTPUT_LIMIT`、`PROCESS_FAILED`、`STDIN_FAILED`、`AUDIT_FAILED`。结束审计等次要错误另带详情，不盖住首要执行原因。只读 Git 的 `SENSITIVE_CONTENT` 必须维持拒绝内容的原约定：**不能因为新增 details.result 而把原本拒绝返回的 Git 内容附回客户端**。

**P4（Q4=B）**：新脚本默认 30 秒，旧查询默认 10 秒；保留短调用上限，明确脚本大小与终止收尾期限。这些是执行预算与收尾预算，不是端到端网络延迟保证；长任务留给 YCA-005，不扩大最长执行时间或增加任务接口。

| 限制 | 已确认值 |
| --- | --- |
| 默认/最大执行时长 | `powershell_execute` 默认 30,000 ms，原 `powershell` 默认 10,000 ms；均可显式设为 1,000～30,000 ms |
| 输出 | 两路合计 1,048,576 原始字节；与当前 1 MiB 保持一致；本票不开放输出上限参数 |
| 脚本文本 | 最大 131,072 UTF-8 字节；独立校验，避免依赖 HTTP 才有限制；整个 JSON 请求仍受现有 1 MiB 约束 |
| 并发 | 沿用共享的最多 4 个实际持有的自有执行名额，不按新旧工具分别计数；不排队，不建设任务管理 |
| 终止/管道收尾 | 触发终止后额外最多 5,000 ms；同一个总收尾期限覆盖 taskkill 与 close/管道收齐，不叠加多次 5 秒等待 |

输出捕获在达到总预算前保存两流数据；跨越上限的 chunk 保留还能容纳的前缀，随后停止持有的进程树。仅本次调用的进程可被终止，不按名称批量杀进程。缓存满后继续排空/丢弃管道以避免阻塞，不增加内存预算。解码处理跨 chunk 的 UTF-8；被硬截断的不完整末尾码点不伪造成完整字符，明确标截断。

生命周期由一个集中执行 Module 负责：先设置终止原因、发起一次停止、继续收集预算内输出；分别观察根进程 exit、两流关闭、停止操作完成。正常尽量等 `close` 再封装结果，但不可将“发出停止请求”当成“已退出”。本轮已查 [Node 子进程事件文档](https://nodejs.org/api/child_process.html#event-close)；实施以已装 Node 24 的事件行为和测试为准。

收尾期限到仍无完整结果时，返回当时部分输出以及 `running/unknown`、null 退出码和停止失败/未确认详情。若根进程已退出但后代仍持有管道，可返回已观察退出码、`exited` 与 `incomplete=true`，不谎报整棵树清空。失败根进程仍占有 children 名额并保留有限量排空与最终退出清理；仅响应完成不能解除所有权。后续真正退出可补写审计，不改变已返回快照；不给远端新增状态查询/stop 接口。

Windows 继续复用现有 taskkill 的自有树路径。无需为本票引入 Job Object、强隔离或追踪任意脱离进程。停止调用失败与自然退出竞态分开记录；任何路径都不得返回两次或无期限等待。

## 6. 已确认：改动位置与兼容安排

已确认调用路径：`公开 MCP powershell / powershell_execute Interface → ComputerTools 对应入口 → 共享 execute Module → 固定 PowerShell 入口 / spawnDirect / stopProcessTree`。

- **公开 Interface**：在 `mcp.js` 保留原查询注册，新增 `powershell_execute` 注册、必填 script 校验和正确 annotations；新入口不接受 query，不采用二选一参数结构。真实客户端观察返回；旧查询输入、正常结果/data 及只读注解保持兼容。
- **执行 Module**：在 `computer/tools.js` 集中实现输出预算、完整结果和有期限收尾；同时供固定查询与 Git 查询复用。保留已有方法，不新增 provider 或调度框架。
- **PowerShell Adapter**：固定入口只负责读取 JSON、设置当前进程 UTF-8/错误策略、解析运行脚本和映射退出；不编排 Skills，不调用 Codex 执行端。
- **测试 Seam**：正常及失败行为优先通过真实 MCP HTTP 客户端、真实 pwsh 和实际文件断言；仅停止失败、审计失败、启动/管道事件竞态等难以稳定复现情形，在现有子进程/审计位置增加最小依赖注入。接口不向远端暴露测试选项，不逐层模拟整套系统。
- 共享 `process.js` 仅在报告停止结果确有必要时调整；保留原调用兼容并运行既有 Codex fake executor 与树终止测试。不改 Codex 模型、权限、环境发现、session/run 持久化。
- 继续现有 cwd 校验及文件/Git 专用策略。本票不增加 allowlist 配置前置步骤，也不把 cwd 校验宣传为限制脚本实际读写的沙箱。脚本内真实能力受运行账号和系统权限影响，不提权。
- 审计只加结束原因、输出字节数、截断/终止/审计状态等元数据；不加脚本文本、两路正文、环境或敏感配置。开始审计失败不执行；执行后审计失败明确表示“操作可能已生效”，保留结果。
- HTTP/stdio 入口、现有认证、runtime、tunnel/key 引用与历史保持兼容。没有脚本请求去重或自动重试的新平台；operation_id 只用于关联。网络断开不会自动启动第二次执行，原调用按既定期限收尾。调用方未收到结果时先核对文件等事实，不能据“非幂等注解”推导 exactly-once 保证。

## 7. 已确认：实现顺序及验收映射

顺序：① 补 MCP 行为测试并固定已确认的输入/错误契约；② 完整结果与输出/终止生命周期；③ 接通脚本入口和错误策略；④ 固定查询、文件/Git、通信及假 Codex 回归；⑤ ChatGPT 既有连接验收及随交付文档。每一步只覆盖本票。

| Issue 验收项 | 实现和测试安排 |
| --- | --- |
| A1-AC1 | 真 MCP 客户端通过 `powershell_execute` 在唯一命名目录创建中文文件、修改后读取；用独立文件读取断言精确文本。再由 ChatGPT 客户端经既有 YCA 连接复现并保存脱敏证据，确认无 Codex 模型调用 |
| A1-AC2 | 真实 pwsh 接收 LF/CRLF、多行 here-string、单双引号、中文/空格路径、反引号和 `$`；参数、文本、落盘内容相互核对。覆盖新入口 script 必填、空白/过大输入及 query 字段拒绝且无副作用，不再测试二选一参数契约 |
| A1-AC3 | 分别验证正常 0、仅 stderr + 0、先写不同两流标记再 exit 7；两流及实际退出码均可读。固定 query 的 `data` 仍可用，脚本 JSON 文本不被额外解析 |
| A1-AC4 | Write-Error、throw、语法错误、原生进程两流后 exit 9；断言后续标记未执行。另覆盖 catch 后成功、非零为业务正常情况的显式处理、错误策略覆盖和非交互 Read-Host；不以 stderr 或陈旧 LASTEXITCODE 判失败 |
| A1-AC5 | 先输出标记再 sleep 超时，以及先输出再超 1 MiB；断言原因、部分输出、截断/中断标记、退出/停止状态。真实自有父子进程验证停止，测试自己启动的 PID；补首 chunk 越限、跨 UTF-8 字符、恰好上限、close/停止竞态。难触发的停止失败、启动失败、管道悬挂和审计失败用最小故障注入，确认按期限返回且不伪造退出码 |
| A1-AC6 | 保留已有 Codex 不可用的 HTTP 测试，并用独立临时 runtime、无效 `--codex-bin` 的进程级启动验证脚本可执行，避免只有伪造 manager。四种 query 的输入、正常结果/data 和只读注解均验证，新工具注解单独验证；覆盖两入口各自默认时长、共用 4 个自有执行名额；文件哈希冲突/不覆盖、Git status/diff 与敏感内容拒绝、HTTP 重连/Host/Origin、stdio 代表调用以及既有 Codex fake executor 回归 |
| 共同约束 | 未确认结果不自动重发；一次断开只启动一个测试副作用；开始/结束审计故障分别断言是否已执行。确认新增错误详情不泄露被原策略拒绝的内容，运行历史/配置未重建，没有付费模型矩阵 |

实施阶段的 ChatGPT 验收使用当前允许目录下唯一命名、无敏感数据的样本；记录工具名、脱敏输入/预期、返回两流和状态、实际文件内容及进程观察。需要已授权的交付安排使现有服务加载新代码并刷新工具元数据；这是未来实施/验收步骤，**本轮不执行也不授权服务变更**，不重建连接资源。

如果当前会话不能代表真实 ChatGPT 客户端，就由用户在 ChatGPT 调用并回传证据；状态继续为待验收，不能用本机 MCP、健康检查或 tunnel 状态替代。失败/不确定先核对事实再决定后续操作。

随交付更新根 README（区分正式 yuki-link 骨架与可运行前置工具）、工具 README（输入、错误/退出、部分输出、限制、中文多行例子、固定查询兼容、非交互与实际验收状态）及本票证据。文档使用中性角色，不提前声称能力已交付，不新建无关架构文档。本轮不提前修改这些用法说明。

## 8. 统一审阅结论

2026-09-16 用户确认设计主线通过：**Q1=B（分开查询与脚本入口）、Q2=A（默认遇到未处理错误停止）、Q3=A（兼容错误信封）、Q4=B（新脚本默认 30 秒）**。第 3～7 节已据此收敛，其余固定入口、UTF-8 传递、完整结果、有限收尾、最小故障注入及 A1 验收映射均获接受。无待确认问题，无需新一轮调查或设计审阅。

## 9. ticket-design 完成与停止点

已将获批决策凝练到[本地票据的 Implementation Notes](001-powershell-execution.md#implementation-notes)，保留原票据及用户未提交修改；未更新远端 Issue，未新增另一份报告。具备进入 implement 的设计条件，无已知设计阻断。

低风险细节留到 implement：内部文件/方法命名、故障注入参数形状、定时器组织、错误文字与测试 fixture 名称；不得借此改变已审阅的公开契约。若实现证据推翻高影响决策，应列事实与最小修订，不静默换方案。

当前 **ticket-design 已完成**，等待用户主动调用 implement；不自动实施、修改生产代码、提交/push、重启服务或更新远端。本机探针和基线测试仅保留原证据，A1 实现后的回归及 ChatGPT 端验收尚未完成，验收勾选保持未完成。

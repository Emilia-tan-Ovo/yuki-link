# Yuki Computer Agent

## Harness 首条持久 Conversation（HARNESS-001 / #40）

新增 Harness 模块使用 TypeScript，由 Node 24 原生类型擦除直接运行；不加 loader、不生成发布构建产物。开发依赖由本包 lockfile 锁定；`npm run typecheck` 独立检查新模块及产品测试，`npm test` 包含既有 JS 和新增 TS 测试。旧 JS 继续受支持。

HTTP YCA 后台启动后独立采集显式关联的 Codex 历史，浏览器关闭不影响记录。可在隔离启动参数中添加 `--harness-port 7394`，从 `http://127.0.0.1:7394/` 打开只读产品页。端口只是示例，必须与 MCP/诊断端口分离；不要把此 listener 配到 tunnel。UI 端口冲突只报告 UI 不可用，不终止后台记录或已有 run。未设置该参数仍可通过 MCP 登记/关联并记录。stdio 生命周期仍跟随客户端，常驻观察应使用已有 HTTP YCA。

- `harness_register_ticket({project_key, project_name, ticket_key, title, reference, expected_worktree?})` 返回 project_id、ticket_id、conversation_id。项目 key 全局唯一，ticket key 在项目内唯一；相同输入幂等，不同内容报 REGISTRATION_CONFLICT。本票不提供修改、删除或重新归属。
- `harness_attach({ticket_id, session_id, run_id?})`：传 run_id 仅收该 run；省略时明确收该 session 的所有已有及后续 runs。应先登记，使用既有 Codex 入口取得真实 ID，再 attach。后台补入已有 message.sent，不要求 UI 同时在线。不存在 session 沿用 SESSION_NOT_FOUND；run/session 不一致或与其他 Ticket 的归属重叠报 ATTRIBUTION_MISMATCH。
- 每张 Ticket 的主 Conversation 身份长期保持。关联新 session 记录切换边界，旧记录保留原 binding；thread 身份仅来自实际事件，不修改原有 THREAD_MISMATCH 保护，也不触发续跑。
- 首页按 Project 分组进入 Ticket；任务、回复、已暴露的命令输出和错误可读，原始来源记录可展开。页面只读刷新；JSON 视图为 GET /api/projects、GET /api/tickets/:id?after=cursor 与 GET /api/conversations/:id?after=cursor。先访问首页建立本机 SameSite/HttpOnly 会话；API/详情须同源 cookie。分页每次至多 100 条，next_cursor 仅表示本地接收顺序。
- 当前 session cwd、Git root/branch 与明确工作目录下 `.local/workflow-state/<ticket_key>.md` 的 ticket/worktree/branch 字段只用于核对。登记 key 用 HARNESS-001 这类文件安全名称时可读取对应 checkpoint；无法读取为 unknown，冲突为 attribution mismatch，不改归属。attach、后台恢复与页面刷新时重新观察，记录时间见 observed_at；checkpoint 不提供 Workflow 完成状态。

数据位于原 `--runtime` 下的 `harness/history.jsonl`，由原 RuntimeStore 独占生命周期保护，不改写旧 sessions.json/runs、不扫描 Codex 私有历史。记录 flush 后发布 cursor，重启重建索引并去重补齐；正文复制进 Harness，源离线仍能读已保存部分。默认无 TTL/自动清理；此版启动时重建内存索引，尚无大历史压测结论。

持久化失败返回 RECORDING_FAILED，页面标记 recording-failed，导入不越过未保存记录。损坏/部分尾记录保留现场和已验证前缀，不自动丢弃或修复；修复存储并核验现场后由既有管理流程重启。source 读取失败单独显示 collection-failed；恢复观察不会重放工程任务。**本票未实现 #44 的全入口 recording gate**，因此不能把“记录健康”当成已经具备系统级副作用门禁的证明。

事件沿用 bridge 的 best-effort 脱敏，新写入注明本次是否改写；旧源逐条脱敏情况为 unknown。OUTPUT_LIMIT 明确提示来源截断。未产生 run 的历史拒绝请求、来源未暴露的工具细节/重试、缺失旧日志均 unavailable；尚未收到的 thread/结果为 unknown。不获取隐藏推理，Provider 已公开文字也不是执行或验收证据。Workflow 记录见下方 #45，Review/Acceptance 子 Conversation 见下方 #46；Changes 与服务状态仍 unavailable，控制按钮与自启属后续票。Owned Task 采集见下方 #43。

现有部署仍执行 `npm ci --ignore-scripts` 并运行 src/main.js；MCP 工具摘要包含四个 Harness 工具（完整 YCA 为 22 个）。这里说明候选源码能力，不表示常驻部署、ChatGPT 真实链路验收或日常稳定使用已经完成。

### 同步电脑调用回看（HARNESS-002 / #42）

8 个现有工具 `powershell`、`powershell_execute`、`filesystem_list/read/write/move`、`git_status/diff` 接受顶层可选 `ticket_id`，值来自 `harness_register_ticket`。例如 `filesystem_read({path, ticket_id})`；不增加工具，不依赖 Codex session。不提供该字段时保持旧行为且不采集正文；未知 Ticket 在操作前返回 `TICKET_NOT_FOUND`，不根据路径或当前界面猜票。调用参数中的 cwd/目标路径与 expected_worktree 仅作带时间的辅助核对，冲突显示 attribution mismatch，不自动改票或阻止原本允许的跨工作区读取。

显式关联调用在后台保存脱敏后的输入与公开结果（失败时包括来源已提供的 `error.details.result`），同一 Ticket Conversation 可在断线、关闭页面或后台重启后回看。返回值另附 `harness_recording`：包含观察用 `call_id`、`ticket_id`、`started/result` 保存状态和观察时间；`call_id` 不是幂等键，响应丢失后应查历史，不能盲重发。MCP schema 在 action 前拒绝的输入和旧审计未记录正文无法补抓。

- 不新增统一 Harness 内容上限；沿用各工具现有脚本/文件/输出限制与拒绝语义，来源实际提供的内容不二次截断。UI 折叠/分页不删正文，stdout/stderr 分开保留，不宣称跨流因果顺序。
- 持久化副本先用既有 best-effort 规则脱敏，不改变实际执行参数，不存秘密原文旁副本；这不是任意秘密检测保证。`integrity.redacted` 表示本次副本处理，`source_redaction/truncated/incomplete` 保留来源事实；来源未给出时为 `unknown`。`stdout/stderr/exit_code` 的 `source-not-provided` 不等于空输出或退出码零。
- `not-yet-observed` 表示还未收到结果；重启后只有 started 则为 `unknown / completion-not-recorded`。`collection-failed` 表示快照采集/保护失败，可写时保存缺口；`recording-failed` 表示落盘失败，不发布未保存 cursor。两类失败不改写原执行成功/失败，也不自动重试。
- 电脑采集缺口不会被成功的 Codex 扫描清除；记录的是当时事实，页面的 `current_process_state: unknown` 不作当前进程存活声明。磁盘故障期间不能保证完整历史，坏 journal 保留现场。
- 正常关闭先停止新入口，等待电脑操作及同步记录收尾，再完成 Codex 最后采集并释放 RuntimeStore 单 writer 锁；无法确认停止时保留锁及只读观察。系统级 recording gate 留 #44，Owned Task 的归属与生命周期留 #43。

该源码交付不代表真实浏览器可用性、resident 部署或 V0 全链验收通过。#43 必须串行基于本票实际 record union、健康投影与 shutdown 契约接入，不独立覆盖共享文件。

### 受管任务持续记录（HARNESS-003 / #43）

现有 `task_start` 增加顶层可选 `ticket_id`，与同步调用一样显式引用已登记 Ticket；省略保持旧行为、原工具数量，不猜票、不自动补关联。归属在受理时固定，并纳入同 service_epoch/request_id 的请求身份：相同输入只找回原 task，改变 Ticket（包括有/无切换）返回 REQUEST_CONFLICT。未知 Ticket 在执行前返回 TICKET_NOT_FOUND。

- 长期记录真实 task_id/service_epoch/request_id、cwd/timeout 等必要元数据，以及 accepted、spawn、公开输出行、错误、停止请求/尝试/结果、root exit、管道关闭和最终 snapshot。UI/observer 断线不拥有采集或任务生命周期；后台事件通知捕捉短暂状态，扫描只补齐仍可取得的公开输出/当前快照。
- **不额外保存完整 task_start 脚本正文**，长期历史明确为 source-not-provided，不从审计、进程或其他日志补抓。只保存 TaskOutput 已解码/脱敏的公开行；沿用原行/事件/分页/输出预算、截断与 output_limit，不新增 Harness 内容上限。
- output 的 seq/stream 原样保存。seq 是 YCA 完整行发布顺序，**非两管道实际写入全局顺序**；journal cursor 是本地提交顺序。生命周期序号独立，两者与 observed_at 均不能推断跨流 OS 因果。exit_code、signal、root_state、pipes_closed 和 tree_kill 分开呈现。
- 每条输出按 source/epoch/task/output/seq 去重；生命周期按独立源序号去重，只有 flush 成功后推进导入进度。重建、重读和回补不重复正文。无第二套 durable queue；未捕获且来源已不保留的生命周期记录明确为缺口，当前 snapshot 不冒充旧事件。
- source-not-provided、not-yet-observed、collection-failed、recording-failed、redacted、truncated 分开保留。同 epoch 的 TASK_EXPIRED 显示 source-expired；新 epoch 显示 source-epoch-expired。已存历史默认无 TTL，旧终态仍可回看；未记录终态的旧任务保持 unknown，绝不映射新 task 或自动重放。
- `task_start` 的可选 `harness_recording` 回执包含 task/ticket、accepted 保存状态与来源健康；已受理但记录失败仍返回真实 task_id/status，不声称“未执行”。#44 gate 未实现，记录故障不拒绝新的 task_start，也不强杀任务；记录期间丢失的事实不能保证恢复。
- GET Ticket 视图的 owned_tasks 分开提供历史 snapshot、source_state 和带时间的 current。当前事实来自 live OwnedTasks；重连/重建重新核对 epoch，源失效后当前状态 unknown。历史不是进程保活承诺；服务关闭复用 #42 多来源收尾，真实终态采集结束前不释放 shared writer。

源码与确定性测试交付不等于 ChatGPT→resident YCA 验收或日常 stable；本票未增加控制按钮、服务管理、自启或 recording gate。

### Workflow 进度与验收证据（HARNESS-005 / #45）

`harness_record_workflow({ticket_id, request_id, expected_revision, schema_version: 1, snapshot})` 为已登记 Ticket 保存完整结构化 Workflow 快照。Project 与主 Conversation 始终从 `ticket_id` 推导；快照只记录/核对 checkpoint、subject、artifact、Review/finding、Acceptance、closeout 与已声明 runtime 引用，不执行下一步、不启动模型、不跑测试，也不写 Git。

- 首次 `expected_revision` 为 `null`；后续必须等于当前 revision。同一 Ticket/request_id 和相同受保护 payload 返回原 cursor/revision，不同 payload 返回 `REQUEST_CONFLICT`；新请求携带旧 revision 返回 `WORKFLOW_REVISION_CONFLICT`。只有 journal flush 成功才发布 revision。
- 文件与 Git 核对仅限 Ticket 登记的 worktree 及快照明确引用的普通文件；不读取 URL、凭据目录、Git 元数据或其他 worktree。产物上限 64 KiB。当前文件、HEAD、branch 或 worktree 身份变化会追加 stale/mismatch/unknown 观察，但不会替提交者改 verdict 或推进 revision。
- 首页与 Ticket 页面展示 phase、两轴 Review/finding、逐 AC Acceptance、closeout 与 applicability。`run completed`、文件存在、Review 报告文字或 Acceptance Agent completed 都不会自动推出 accepted；只有明确 passed、逐 AC 证据、适用 subject 和 Review/finding 门槛同时成立才显示当前 accepted。
- Workflow 使用原 `harness/history.jsonl` 的 source_id/event_id/cursor 与单 writer/flush 语义，重启重建 revision、request 幂等和最近事实观察；旧记录原样可读。页面仍为 GET-only，浏览器没有 Workflow 写入口。
- 本票不创建 Review/Acceptance 子 Conversation（留 #46），不实现 Changes、recording gate、自动恢复/执行或服务管理。源码与 fixture 通过不表示 resident、真实浏览器链路、正式 Acceptance 或日常 stable 已完成。

### Fresh Review 子 Conversation（HARNESS-006 / #46）

`harness_associate_child_conversation({ticket_id, request_id, session_id, run_id, relation})` 只记录已经真实启动的 Review 或 Acceptance Agent execution。Review relation 明确给出 `review_id` 与实际存在的 `coordinator | standards | spec` participant；Acceptance relation 给出 `acceptance_id`。入口不启动、发送或续跑模型，也不改变 `harness_attach` 的 Ticket 主 Conversation 语义。

- 当前 Workflow 必须存在相同稳定 identity，并通过 `execution_refs` 指向与输入 session/run 相交的 `codex-run` runtime ref。Review schema 的 `execution_refs` 为向后兼容可选来源；旧快照缺失时不能建立关联。Acceptance 仅允许 `actor.method=agent`；Emilia deterministic Acceptance 不创建子 Conversation。
- 同 Ticket/relation/participant 保持稳定子 Conversation；focused re-review 使用自己的 `review_id`，并从 Workflow 投影原 Review/finding 链。只有实际关联的 participant 才展示，不为 Standards/Spec 创建占位。
- 子 Conversation 与首个或 replacement run binding 在单条 Journal operation flush 后发布；同 request_id 相同 payload 返回原回执，不同 payload 返回 `REQUEST_CONFLICT`。session/run 已属于主 Conversation、其他子 Conversation 或其他 Ticket 时返回 attribution conflict。重启从原 Journal 重建 relation、binding、幂等索引与导航。
- Harness 使用 Workflow execution ref、真实 session/run、首次 run 与 thread.started 来源计算 isolation assessment。证据完整为 `verified`，来源不足为 `unknown`，发现 session/thread/run 复用或冲突为 `mismatch`；Workflow 报告的 `isolated` 单独展示，父子关系本身不作为 fresh 证明。
- Ticket API/页面保留主 Conversation 历史并列出子 Conversation 导航；子详情只读取该 Conversation 已绑定 execution 的保存事件。页面延续 loopback Host/Origin、SameSite/HttpOnly cookie、CSP、no-store、escaping 与 GET-only 约束。
- 本能力仍是候选源码实现；未执行 full suite、真实 ChatGPT/reviewer/Acceptance 链路或日常 stable 验收时，不得作更高等级声明。Changes、自动 reviewer 编排、非 Codex Provider、服务管理与自启不在本票。

独立的前置开发工具，不属于 yuki-link 正式 ticket，也不依赖 `core/` 或 `providers/`。

保留 `tools/codex-session-bridge` 目录，避免迁移已有 session/runtime。Computer Agent 直接提供固定 PowerShell 查询、真实短脚本及专用文件/Git 工具；Codex 模块只传输 prompt、管理 session/run、返回事件与回复。两条路径互不依赖：Codex 不可用不会阻止电脑工具启动。它不编排 Skills；调用方可在 prompt 中写 `$pair-with-docs`、`$implement`。会话由本工具新建并管理，不接管 Codex 桌面中正在运行的任务。

## 本机启动

常驻 Control Center 部署应使用[独立部署副本与更新入口](../control-center/README.md#常驻-yca-源码部署issue-11)，避免功能分支或未提交修改与已合并版本脱节。部署源码和原 `--runtime` 数据目录分离；不迁移 session/history/tunnel/key，也不要求所有开发票据使用 worktree。受认证的本机诊断会记录启动时的源码 commit/dirty 和实际工具摘要；正式切换与 ChatGPT 验收需在合并后执行。

要求 Node.js 24+；电脑查询使用 PowerShell 7、Git，真实脚本入口要求 PowerShell 7.4+ 的原生命令错误语义，已在独立服务进程验证 7.6.5。Codex 功能另外需要可执行的 CLI 及其既有登录，YCA-006 实施时实际验证 CLI 为 `0.155.0-alpha.2.6`；版本相关权限字段仍以运行中 CLI 的原生解析结果为准。Agent 不读取、复制或保存 Codex 凭据。

在本目录运行（Windows 使用 PowerShell 7）：

```powershell
npm.cmd ci --ignore-scripts
node src/main.js --transport http --allow-cwd 'C:\projects\yuki-link'
```

HTTP 只绑定 `127.0.0.1`，默认 MCP 地址 `http://127.0.0.1:7391/mcp`，健康检查 `/healthz`。不监听局域网地址。仅信任本机调用方；远程接入必须由单独授权的 tunnel 保护。Host/Origin 校验阻止普通浏览器跨站请求和 DNS rebinding，不替代身份认证。

可重复传入 `--allow-cwd` 添加管理员允许的工作目录。路径会取真实路径再校验，包含子目录，拒绝越界和 junction/symlink。脚本入口仍校验 cwd，但这不是脚本的访问沙箱：脚本实际读写、原生命令和外部访问受运行账号与系统权限影响。工具不提供任意 CLI flags 或提权开关，不增加额外批准机制。

`--allow-cwd` 同时限定 Codex 工作目录和文件写入范围。`--read-root` 可重复添加额外只读目录，用于目录列举、Git 查询和直接 PowerShell cwd 校验。`filesystem_read` 可读取任务明确指定的区外普通文本，仍受下文保护规则约束；其他入口范围不随之扩大。其他本地参数：`--port`、`--runtime`（绝对路径）、`--codex-bin`、`--pwsh-bin`。未指定 allowlist 时拒绝启动。`--help` 查看参数。

Windows 常驻服务可以显式传入 `--codex-bin 'C:\path\to\codex.exe'`，并继续使用原来的 `--runtime`。每次能力发现或会话启动前验证文件及原生 `--version` 探测；有效显式路径优先。路径失效时先查 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`（按文件修改时间从新到旧尝试），再查服务 PATH 中的原生 CLI；默认 `codex` 则先查 PATH 再查 Desktop 安装。无须修改 PATH 或手工跟随 hash 更新。发现结果仅用于运行时，不回写已有配置；成功探测缓存每次按文件身份、大小和时间重新验证，删除/替换后重新发现。拒绝 `.ps1/.cmd/.bat` shim，始终 `shell:false`。

`CAPABILITY_UNAVAILABLE` 的 `details.configured_status` / `discovery_status` 区分配置路径和自动发现失败；`ENOENT` 表示缺失，`ENOEXEC` 表示不可用原生程序，`ETIMEDOUT` 表示探测超时。会话执行阶段发现失败使用 `CODEX_EXECUTABLE_UNAVAILABLE`。检查安装或 `--codex-bin`，不能简单归因于 PATH；无需重新登录、重建 tunnel 或清空 runtime。对外不返回 CLI 路径、环境或启动 stderr。能力查询仍按需执行，失败不会阻止独立启动的 YCA 直接电脑工具。

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
| `harness_register_ticket` | `project_key, project_name, ticket_key, title, reference, expected_worktree?` | 稳定 `project_id, ticket_id, conversation_id` |
| `harness_attach` | `ticket_id, session_id, run_id?` | 显式 Codex 归属与 recording 状态 |
| `harness_record_workflow` | `ticket_id, request_id, expected_revision, schema_version: 1, snapshot` | `workflow_revision, event_id, cursor, deduplicated, applicability, recording` |
| `harness_associate_child_conversation` | `ticket_id, request_id, session_id, run_id, relation` | `conversation_id, parent_conversation_id, binding_id, isolation, event_id, cursor, deduplicated, recording` |
| `codex_list_models` | `refresh?` | 本机模型、各自 reasoning 档位、查询时间 |
| `codex_start_session` | `request_id, cwd, prompt, permissions?, sender?, model?, reasoning?, timeout_ms?` | `session_id, run_id, status, model, reasoning, permissions, timeout_ms, deduplicated` |
| `codex_send_message` | `request_id, session_id, prompt, sender?, model?, reasoning?, timeout_ms?` | 同上；权限固定继承 session，不能在续聊中切换 |
| `codex_get_status` | `session_id? / run_id?`，至少一个 | session、选定 run、当前 session 状态 |
| `codex_get_output` | `run_id, cursor?, limit?, wait_ms?` | 事件、`next_cursor`、`has_more`、状态、最终回复、`return_reason` |
| `codex_stop_session` | `session_id` | 停止进度，需继续查状态 |
| `powershell` | `cwd, query, timeout_ms?` | `operation_id, exit_code, stdout, stderr, data` |
| `powershell_execute` | `cwd, script, timeout_ms?` | 执行结果；失败时位于 `error.details.result`，包含部分输出及终止信息 |
| `task_start` | `service_epoch, request_id, cwd, script, timeout_ms?, ticket_id?` | `task_id, status, deduplicated, harness_recording?`；异步受理自有前台任务 |
| `task_status` | `task_id?` | 无 ID 返回本次 epoch/预算；有 ID 返回任务快照 |
| `task_output` | `task_id, cursor?, limit?` | 独立两流行事件、`next_cursor, has_more, output` |
| `task_stop` | `task_id` | 停止进度快照；继续查询以核对终态 |
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

### 自有前台任务（YCA-005）

先调用 `task_status({})` 取得 `service_epoch`，再用调用方生成的 `request_id` 调用 `task_start`。`cwd` 和 `script` 与 A1 相同，脚本仍由固定 `execute.ps1` 接收 UTF-8 JSON stdin；脚本应同步调用或等待目标程序。`Start-Process` 后立刻退出的后台程序不在可靠托管承诺内。A1 短调用和 Codex session/stop 契约不变。

例如 start 输入（将 epoch 和 cwd 换为实际返回值及目标目录）：

```json
{"service_epoch":"返回的UUID","request_id":"my-task-001","cwd":"C:\\projects\\sample","script":"1..300 | ForEach-Object { [Console]::Out.WriteLine($_); Start-Sleep -Seconds 1 }","timeout_ms":600000}
```

保存返回的 `task_id`；用 `task_output({task_id,cursor:0,limit:100})` 读取，后续带回 `next_cursor`，用 `task_status({task_id})` 查询，用 `task_stop({task_id})` 请求停止。输入对象拒绝额外字段，不接受任意 PID。任务自身失败通过快照的状态、原因及实际退出码表达；非法输入、未知任务、过期或容量不足沿用 MCP 错误信封。

start 响应丢失时，用**原 epoch、request_id、cwd、script 和相同有效 timeout**重试，返回同一任务，不重新执行；相同 request_id 配不同输入报 `REQUEST_CONFLICT`。HTTP 客户端断开不停止任务，重新连接后沿用 ID。服务重启生成新 epoch，旧 epoch 的 start 报 `TASK_EPOCH_EXPIRED`，旧 ID 查询报 `TASK_NOT_FOUND`；不要擅自更换 epoch 后重放未知副作用。stdio 关闭 stdin 会关闭服务，不属于服务存活期间的重连。

| 预算 | 值与边界 |
| --- | --- |
| 脚本/时长 | 128 KiB UTF-8；默认 5 分钟，可选 1 秒～30 分钟（包含启动时间） |
| 活跃名额 | 与 A1 查询、脚本及 Git 共用 4 个；不排队，查询与 stop 不占新名额 |
| 完整记录/映射 | 64 份完整记录、1024 个 request_id 映射；满额拒绝新任务，原任务仍可观察和停止 |
| 过期 | 只有终态且释放资源后满 30 分钟，后续访问时释放正文；本次服务保留摘要墓碑，报 `TASK_EXPIRED`，异输入仍报冲突，不将同键当新任务 |
| 输出 | 两流合计 1 MiB 原始字节、最多 4096 事件、单行 64 KiB；超限请求停止并保留已发布事件 |
| 分页 | limit 默认 100、范围 1～200；单页 JSON 序列化结果≤512 KiB，含编码膨胀 |
| 停止 | 每次尝试最多 5 秒；进行中不叠加，失败后可显式重试，禁止对已退出根 PID 重试树杀伤 |

快照分别报告 `root_state`、真实 `exit_code/signal`、`termination`、`tracking_scope`、`output`、`audit` 与时间戳。`output.pipes_closed` 与 `incomplete` 分开表示管道收齐与输出完整性；停止后的管道可以已关闭而输出仍不完整。`completion_reason` 区分自然退出、超时、输出超限、启动/管道/审计错误、主动停止和服务关闭；停止错误不覆盖首要原因。

- `starting/running/stopping` 均非终态；`unknown` 表示根或停止结果尚未收尾，例如父退出但管道悬挂。它仍占有名额，不按终态淘汰。
- `completed` 表示前台根成功退出且管道收齐；`failed` 表示已收尾的执行/停止等失败。失败时保留已取得的输出。
- `stopped` 要求根退出、管道关闭及树停止操作成功；停止命令成功本身不足以宣称任务已停。树停止失败后仅观察到根退出，不能改报 stopped。
- 晚到退出/停止证据可推进状态。停止不撤销文件等副作用；根退出和管道关闭均不能证明任意脱离后代消失。

事件为不可变 `{seq,stream,text}`；两流各自保序，不承诺真实跨流时间顺序，cursor 是下一事件序号。UTF-8 跨 chunk 解码，完整行统一使用既有 best-effort redact；正常 EOF 可发布尾行。无换行内容在收齐前不可见，空页不表示结束。超限/中断不发布被切断的 token 尾段；`*_truncated/incomplete/redacted` 明确说明丢弃、未收齐或改写。此规则不能识别所有秘密，不应向脚本输出凭据。审计仅写必要元数据，不写脚本或输出正文。

当前候选源码共有 18 个 MCP 工具。候选测试使用独立 runtime/端口、真实 PowerShell 前台父子夹具和不可用模型/fake 接缝。艾米莉亚已完成独立源码复核，并经当前 YCA 短脚本访问隔离候选 HTTP/MCP 验收：67.61 秒跨客户端观察、幂等找回、实际停止范围及结果/输出用例均通过，详见 [YCA-005 状态](../../docs/tickets/yuki-computer-agent/005-owned-tasks.md#本地实现与验收状态)。候选验收链路 0 模型调用，开发与审查使用 Codex。验收时常驻仍为 `245758d` / 14 工具；候选通过不等于常驻 18 工具直接验收，升级、插件刷新及常驻验收留待 PR 合并后单独处理。

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

首次创建默认 `gpt-5.6-sol / medium`。模型目录来自当前 `codex app-server model/list`，含分页，缓存五分钟，可显式刷新；目录查询失败不猜测、不静默降级。新增模型无需修改 session 逻辑。

后续消息未指定的 model/reasoning 字段分别继承 session。只指定新 model 时 reasoning 仍继承原值；组合不支持就明确报错。每个 run 记录本轮传给 CLI 的配置；session 在 Codex 返回 thread ID 后更新配置。`config_source` 区分新 session 的 `session_permission_snapshot` 与旧 session 的 `legacy_explicit_codex_cli_arguments`；权限值来自 Codex 原生配置解析和持久化快照，不依靠模型自述。

`start/send` 校验并持久化后立即返回，不等待模型生成。能力目录过期时可能先花数秒刷新，超时则报 `CAPABILITY_UNAVAILABLE`。同一 session 最多一个 active run；并发提交不同请求返回 `SESSION_BUSY`，不会暗中排队。

Codex run 默认没有 wall-clock hard execution deadline：省略 `timeout_ms` 时，run 持久化 `null`，不会因为运行超过固定时长而被 Bridge 停止。只有调用方明确传入 1,000～1,800,000 ms 时才创建 hard deadline；到期后请求停止，并在进程实际结束时进入 `timed_out`，错误为 `RUN_TIMEOUT`。该值从 run 受理结果和 status 可见。hard deadline 与下述 observation wait 相互独立；一次观察结束不会设置、刷新或触发 run deadline。

客户端用相同 `request_id` 和完全相同参数重试，得到原来的 `run_id`；修改参数复用 ID 则报 `REQUEST_ID_CONFLICT`。幂等范围是整个 runtime，同一消息的默认参数“省略”与“显式传入”不视为相同请求。新一轮消息必须换 ID。HTTP 连接断开不会取消 run。

`get_output` 的 cursor 从 0 开始，代表该 run 已读取的事件数。保留 `next_cursor`，`has_more=true` 时继续翻页。失败也可以读取已生成内容。

省略 `wait_ms` 或传 `0` 保持原有即时读取。传入 1～60,000 ms 时，调用会等待到 cursor 后出现新的 durable event、run 已进入终态或本次 observation window 到期。`return_reason` 分别为 `events`、`terminal`、`wait_elapsed`；已有 backlog 总是立即按 limit 返回。terminal 且没有未读事件时返回空事件页及 final response。`wait_elapsed` 只表示本次没有更多内容，run 仍可继续执行；客户端取消或 HTTP 断开也只取消这次 observation，重连后继续使用同一 run ID 和 cursor。

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

单次运行默认没有 hard deadline；需要时可显式指定 1 秒到 30 分钟。prompt 上限 128 KiB；单行进程输出上限 2 MiB；单次事件日志上限约 16 MiB；超限会停止运行并报错。MVP 使用文件和内存，不适合长期大量并发；请定期在服务停止后归档 runtime。

## 执行与权限边界

所有子进程使用 `spawn(executable, args, { shell: false, windowsHide: true })`。完整 prompt 只经 UTF-8 stdin 发送，不作为命令参数拼接。stdout JSONL 和 stderr 分开解析，支持跨 chunk 的中文字符。resume 始终使用已保存的 Codex thread ID，不使用 `--last`。

新 session 创建时通过当前 Codex CLI 的临时 `app-server config/read` 按 `cwd` 解析有效本机权限；不传 `permissions` 时采用该时刻的有效默认。显式选择当前支持 `read-only / workspace-write / danger-full-access` sandbox，可同时指定 `on-request / never` approval 与 reviewer；未显式填写的权限字段同样先由 Codex 原生配置解析，再写入 session 快照。Bridge 不自行解析用户 TOML，也不修改全局 Codex 配置。

权限快照为版本化的可重放执行契约：记录 sandbox、approval、reviewer，以及 workspace-write 的 writable roots、network 和 tmp 细项。每次 `exec/resume` 同时显式重放对应 sandbox 与 Codex 保留的内置 permission profile（`:read-only / :workspace / :danger-full-access`），并固定 approval/reviewer；因此本机默认后来变化或新增自定义 permission profile 不会静默改变已创建 session。无法完整展开并重放的 `default_permissions` / 自定义 permission profile、未知 workspace 权限维度或损坏快照会明确失败，不猜测或降级。

新 session 不再使用 `--ignore-user-config`，也不再统一关闭 apps/plugins/hooks/browser/computer；这些非权限能力继续按用户现有 Codex 配置加载。YCA-007 已在常驻 Bridge 的同一真实 session/thread 中完成 `$code-review` Skill 实际使用和 Context7 `resolve-library-id` / `query-docs` MCP 调用，证明该继承路径可用。Full Access 只表示 Codex 原生执行权限，不构成无关操作授权，也不让 Bridge 自建批准转发平台。

### Skill / MCP / Plugin 环境（YCA-007）

环境状态必须区分“本机存在/安装”“CLI 识别”“Bridge session 加载”“实际调用”四层，不能把前一层当成后一层证据。2026-09-18 在 Codex CLI `0.155.0-alpha.9` 和常驻 YCA 上的代表性结果：

| 项目 | 本机/安装 | CLI 识别 | Bridge session 加载 | 实际调用 |
| --- | --- | --- | --- | --- |
| 本机 `$code-review` Skill | 已存在 | session 可发现并执行其流程 | 是 | 是；同一 thread 完成固定点、Standards 与无-spec 分支 |
| `context7` MCP | 已配置 | enabled | 是 | 是；真实调用 `resolve-library-id` 与 `query-docs` 并取得 Node.js 官方文档 |
| `cua_repl` MCP | 当前 CLI 提供 | enabled | 未验证 | 未验证 |
| `node_repl` MCP | 当前 CLI 提供 | enabled | 未验证 | 未验证 |
| `codex_app` MCP | 当前 CLI 提供 | disabled | 否/未加载 | 未调用；保持用户禁用状态 |
| 其他 Codex Plugins | `plugin list` 中当前有 16 项显示 `installed, enabled` | 已由 CLI 列出 | 未逐项验证 | 未逐项调用 |

当前 Context7 配置中的 `mcp_servers.context7.type` 会被 CLI 报为 unrecognized/ignored；同一配置仍通过 `url` 被 CLI 识别为 enabled，并已在 Bridge session 中真实调用成功。因此这是非阻塞兼容提示，不要求为了验收修改用户全局配置。其他未实测 MCP/Plugins 明确保持“未验证”，不据安装清单或模型自述宣称可用。

上述四层状态是点时环境证据，不是永久白名单。“本机/安装、CLI 识别”以当次真实 `codex mcp list` / `codex plugin list` 为 source of truth；“Bridge session 加载、实际调用”以常驻 YCA 对应 run 中的 durable `mcp_tool_call` / command / collaboration 事件及终态为 source of truth。CLI 版本、用户 MCP/Plugin 配置或安装/启用状态变化后应重新核对相关层：至少刷新 CLI 清单，并对受影响的必验 Skill/Context7 做代表性调用；不因无关插件变化重跑完整付费矩阵。Codex Desktop executable 的 hash 路径不写入这里，YCA 会在能力刷新与新 session 启动时按实际安装动态重发现。

YCA-007 的 Skill/Context7 验收由 ChatGPT 当前对话直接调用已注册的常驻 YCA `codex_send_message / codex_get_status / codex_get_output` 完成；没有以本地候选 HTTP、直接 CLI 脚本或模型自述替代 ChatGPT → 既有 YCA 的公开边界。

旧 runtime 中没有权限快照的 session 保持旧版本完整语义：`read-only + never + --ignore-user-config`，并继续关闭旧实现原先禁用的 features；不会套用当前本机默认或静默升级。需要另一权限模式时创建新 session，`codex_send_message` 不接受会话内权限切换。旧 request_id 的历史 fingerprint 仍可按原参数重放；新 start 的权限输入参与新的幂等一致性判断。

Windows 停止只对 Bridge 持有的 ChildProcess 使用 `taskkill.exe /PID <pid> /T /F` 参数数组，不接受调用方 PID，不按进程名批量结束。PermissionResolver 的临时 app-server 同样属于自有进程，正常结束有短暂收尾窗口，超时则使用既有自有树终止逻辑。其他平台使用自有进程组，尚未在本项目进行平台实测。

## 本地验证

```powershell
npm.cmd test
npm.cmd run test:live
# YCA-006：显式联网/模型权限行为验收，只在受控临时 Git 仓库运行
npm.cmd run test:permissions-live
```

常规测试不调用模型，包含真实 MCP HTTP/stdio 客户端、PowerShell 短脚本文件闭环、退出语义、部分输出、Windows 自有进程树终止、最小故障注入、断线不重放、临时文件/Git 仓库及既有 Bridge 回归。独立 stdio 服务用无效 `--codex-bin` 验证直接能力不依赖 Codex。`test:live` 是另外的显式联网验收，会使用 CLI 当前登录和模型额度；`test:permissions-live` 专用于 YCA-006：使用独立临时 `CODEX_HOME` 让真实 `config/read` 提供可控默认，在临时 Git 仓库外部核对默认 Full Access 的读写/命令/diff、默认改成 read-only 后旧 thread 仍按冻结快照写入，以及显式 read-only 的实际写入拒绝与文件不变。两者都不会由常规 `npm test` 自动触发。

YCA-002 的 `test/text.test.js` 使用真实 HTTP/MCP 和临时文件，封堵并计数 model start/send/executor，验证文件调用为零模型调用。覆盖区外/Skill 文本、BOM/换行、短读/增长/大小边界、冲突/no-op、敏感路径/内容、链接及其他入口不扩围。Windows 测试报告实际可用的 8.3 别名数量。可在当前 PowerShell 进程设置 `YCA_TEST_SKILL` 为获准读取的真实 `.agents/skills/.../SKILL.md` 或 `.codex/skills/.../SKILL.md`，再运行 `node --test test/text.test.js`，只读取并核对原字节、哈希及未修改状态；未指定时该真实文件用例跳过，其他用例使用夹具。仓库没有 typecheck 脚本，使用 `node --check` 检查 JavaScript 语法。

YCA-002 在代码提交 `f6495fb` 完成 Bridge 52/52、Control Center 16/16、文本/路径针对性检查 13/13，均无跳过。两个独立审查轴中，Standards 初审/复查均 0 项；Spec 发现 1 项 UNC 分隔符问题，修复后复查剩余 0 项。后续仅更新验收文档，未重跑全套测试。

艾米莉亚独立审阅该提交，16 组检查及三次独立请求的交互核验通过。实际路由是 **ChatGPT → 现有 YCA 的 `powershell_execute` → 隔离候选版本公开 HTTP/MCP**：读取区外资料、真实 ticket-design Skill（6098 字节，仅只读）及样本，携带先前实际返回的哈希更新，再核对返回内容与磁盘哈希。最终样本 95 字节，SHA-256 为 `a15d6f590104e5448aad081452248cddca07136d853c562ff85c2fe0d4b6677b`；manager start/send、executor、spawn、catalog 均 0 调用。验收进程已退出，临时样本已清理。

这是经过现有连接的候选版本独立读写往返；常驻 YCA 和 ChatGPT 已注册 `filesystem_*` 工具均未切换到新版本，没有部署或重启。因此不表示常驻工具加载后的验收或所有端到端验收完成；原验收框仍未勾选，详见 [YCA-002 验收记录与传输诊断](../../docs/tickets/yuki-computer-agent/002-text-and-skills.md#yca-002-本地实现与验收状态)。

YCA-001 本机回归 39/39 通过；2026-09-16 用户确认 ChatGPT → Yuki Computer Agent → PowerShell 7 的真实验收通过，全程未经过 Codex。中文/引号/多行文件闭环、两流与退出语义、超时/超限部分输出及四种旧查询均通过，详见 [YCA-001 验收记录](../../docs/tickets/yuki-computer-agent/001-powershell-execution.md#本地实现与验收状态)。输出超限用例的根进程已退出，但 `tree_kill=unconfirmed`，保留这一未确认状态；超时用例则确认 `tree_kill=succeeded`。本机结果与用户提供的 ChatGPT 验收证据分别记录。

真实验收报告保存在 `runtime/live-<timestamp>/acceptance.json`；不会提交实际会话记录。此次初始本机验收三轮均成功，使用同一个 Codex thread。这不表示每个 reasoning 档位都已实际请求过。

## 复用 Yuki Computer Agent tunnel

沿用用户已配置并命名为 **Yuki Computer Agent** 的 tunnel（连接 ID 从本地配置获取，不记录在仓库中）。本机目标 `http://127.0.0.1:7391/mcp`，客户端 `tunnel-client v0.0.14`。内部 runtime alias/profile 继续使用 `codex-session-bridge`；不创建新 tunnel/key，也不修改其他 Windows-MCP tunnel。

本机凭据引用由用户在本地配置，文档不记录实际存放路径，仅 tunnel-client 读取用于认证；Agent 不读取它，不把内容加入 prompt、日志或 Git。名称变化不会要求重新生成 key；到期、撤销或损坏时才需要处理凭据。

继续复用现有 **Yuki Computer Agent** tunnel 和 key。YCA-001 交付时，本机已暴露 14 个工具，但 ChatGPT 端插件刷新后仍只有旧 13 个；用户删除后重新安装插件，才加载到包含 `powershell_execute` 的完整清单。遇到同类情况应以实际工具清单和新对话调用为准，必要时重装 ChatGPT 端插件并选择原 tunnel，不重建 tunnel/key，不清空 runtime。

YCA-001 当时加载后共 14 个工具，其中 `powershell` 为固定查询，`powershell_execute` 为新增脚本入口。其 ChatGPT 文件闭环、错误、超时/超限验收已通过，全程不调用 Codex 模型。当前 YCA-005 候选源码另增 4 个 task 工具；tunnel ready、本机测试及工具发现不能单独替代常驻新工具的 ChatGPT 验收，Codex 协作验收仍属于独立后续安排。

参考：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[App Server](https://learn.chatgpt.com/docs/app-server)、[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)、[Tunnel 接入](https://github.com/openai/tunnel-client/blob/master/docs/enterprise-customer-onboarding.md)。

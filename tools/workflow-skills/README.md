# Workflow Skill preview / apply / verify

独立本地工具，要求 Node ≥24 和已安装 Git；无 npm 运行时依赖，无网络请求。使用仓库版本化的 `.workflow/skills/manifest.json` 与所选 Skill 完整文件集，不搜索或依赖 `rg`。YCA 生产代码、`PROTECTED_PATH`、用户 Codex config 均不参与安装流程。

## 批准边界

Agent 可以编辑 repo source、生成 preview 和运行只读 verify。**真实 `~/.agents/skills` 写入必须由 Owner 审阅具体计划及完整 diff，明确批准其 digest、canonical 目标和写集。** 随后由 Owner 在本机运行已审阅的 installer，或通过原生执行器明确允许的那一次写入完成。遇到原生拒绝应停下；不能通过 YCA `powershell_execute`、owned task、普通 filesystem、别名或扩展 roots 绕过保护。

`--approve` 是对具体计划的确认输入，不是身份认证、签名或权限凭证。JSON 中的字段不能授予写权限。执行器、Node、Git 和所运行的 installer 必须已经可信；工具不能证明输入摘要的人是谁，也不是防御恶意同用户进程的 OS 沙箱。运行中的 installer 自身不能可靠审查替换它的恶意代码。尚未实现的 `review-change` source 由清单拒绝安装。

## 三个命令

在 PowerShell 7 中使用绝对路径。以下变量应指向已审阅的 checkout 和**本轮明确授权的测试安装根**；目标根必须预先存在。真实安装根以后再单独批准，不从环境自动选取。

```powershell
$repoPath = (Get-Location).Path
$targetPath = 'C:\task-fixtures\skills'
$preview = node ./tools/workflow-skills/src/cli.js preview --repo $repoPath --target $targetPath --skills implement,ticket-design | ConvertFrom-Json
Get-Content -LiteralPath $preview.plan -Raw -Encoding utf8
Get-Content -LiteralPath $preview.diff -Raw -Encoding utf8
```

preview 只读安装目录，在 `.local/workflow-skill-apply/<id>/` 保存 `plan.json` 和 `diff.txt`。输出中的 `applyable` 只表示内容前置条件，不表示已获授权。明确批准后，使用当时审阅并保存的 digest，不重新读取一个可能已被替换的 digest 来冒充旧批准：

```powershell
$reviewedDigest = '<明确批准的 SHA-256>'
$reviewedPlan = '<该计划的绝对 plan.json 路径>'
node ./tools/workflow-skills/src/cli.js apply --plan $reviewedPlan --approve $reviewedDigest
node ./tools/workflow-skills/src/cli.js verify --plan $reviewedPlan
```

每次检查原生进程 `$LASTEXITCODE`：`0` 是 preview 已生成或内容已 verified；`1` 是拒绝、漂移或失败。stdout 为一个 JSON 对象。apply 不接受临时覆盖 target / source / selection 的参数，没有 force、全局自动安装或自动删除。

## 计划绑定与来源

计划绑定 source repo、HEAD commit、清单哈希、所选文件路径及完整字节 SHA-256，installer `src/**` / `package.json`，Node 路径/版本，以及从绝对 PATH 条目重新发现的 Git canonical 路径/二进制哈希。Git 不从当前工作目录查找。目标绑定 canonical 根与文件系统身份、所选目录/文件完整清单、旧/新哈希；写集包含目录、临时文件、排他锁和本地恢复材料。

preview 可以显示未提交的候选，但 apply / 成功 verify 要求所选 source、manifest 和 installer 与记录的 commit **原始字节、文件集**一致；不会把工作区中的未提交内容冒充该 commit。无关票据文档可以未提交。批准后 source、HEAD、工具、Git 位置或目标状态变化均需重新 preview；apply 会在锁内再核对，verify 也重新读取文件，不信任旧回执。若 source checkout 已变化或不可用，verify 返回 `source-unavailable`，不能只拿旧哈希文件宣称版本可追溯。

diff 是包含每个被修改文件完整旧/新文本的替换式展示，不是可执行 patch；CRLF/BOM 由字节哈希及原样复制保留，不能只靠编辑器显示判断换行。单文件、计划和 diff 各限 256 KiB UTF-8；超过限制明确拒绝，不生成可批准的截断 diff。目标多余文件或目录列为 `extras`，阻止 apply；它们不会被静默删除。所选 Skill 外的目录不纳管。

## 失败与恢复

apply 在目标根独占 `.workflow-apply.lock`，因此不同 worktree 不能同时操作同一安装根。创建 intent、写齐全部原始覆盖备份及 `backup-complete.json` 后才改 Skill 内容。新文件通过不覆盖已有目标的发布方式创建，替换使用同目录临时文件；路径、链接和旧字节在写前再检查。这不是跨文件事务或原子 CAS。

| 结果 | 含义及下一步 |
| --- | --- |
| `error` | 参数、批准、路径、来源或计划检查拒绝；根据 code 重新调查，不能自动补一个批准摘要 |
| `not-applied` | 已取得锁，但在 Skill 写入前失败；保留 intent、已有备份及锁，人工检查 |
| `partial-or-unknown` | 安装或最终记录中断/失败；可能已有部分写入，不自动回滚或重试 |
| `drift` | verify 观察到 missing / content-drift / extras；这不是安装成功 |
| `source-unavailable` | 无法证明当前 source/tool 与预期版本一致 |
| `verified` | 在 `observed_at` 重读的所选完整内容与 source commit/digest 相符 |

失败保留原始备份 `backup-<文件相对路径 SHA-256>.bin`、intent、已完成动作、锁和可能的临时文件。突然进程退出可能没有 `failure.json`，不能将缺失失败记录解释为成功；同样，receipt 只证明记录时间的内容核验，不代替锁或进程状态检查。

恢复时先读计划/intent、检查锁的实际持有者及目标字节，明确哪些动作已发生。未知锁不能按“看起来过期”自动删除。Owner 明确批准后，人工处理已确认归属的锁/临时文件，必要时从原始备份恢复；再重新 preview、批准、apply。工具不提供自动清理、卸载或恢复命令，不盲重放旧计划。保持现场，不能以强杀未知进程解决锁。

## 安装内容与实际加载

verify 确认磁盘内容和版本，不证明当前会话已重新加载 Skill。后续 fresh session 必须核对实际发现的 Skill 路径并重新读取；选到了重名旧副本时不能算激活成功。fixture 通过只证明该路径实现，真实 protected apply 和 fresh-session 激活验收仍需另行批准；不表示日常 stable。

## 测试与维护

`npm test` 从公共 CLI 创建临时 Git 仓库及测试安装根，覆盖完整 diff、批准/漂移、版本核验、未知文件、链接、Windows 路径、无 rg、原字节保留、互斥、故障和中断。故障由测试子进程在 OS 文件操作处注入，生产入口没有测试开关。`npm run check` 对全部源文件做 Node 语法检查；本工具没有 TypeScript 或额外 lint 配置。

YCA 回归入口是 `tools/codex-session-bridge/test/workflow-protection.test.js`、`text.test.js` 与 `control-paths.test.js`；断言普通 MCP 文件工具仍拒写安装版 Skill / AGENTS，同时 repo source 可编辑。搜索维护资料时先 `Get-Command rg -ErrorAction SilentlyContinue`；没有 rg 则使用限定目录的 `Get-ChildItem` / `Select-String`。

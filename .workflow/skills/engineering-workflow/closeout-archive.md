# Closeout archive

在 closeout 阶段读取本说明，使用本 Skill 所在目录的 `scripts/closeout-archive.mjs`。Node ≥24，无额外依赖。Emilia 根据 Ticket、handoff 和实际 Git / review / acceptance / run 证据整理精简输入；checkpoint 只用于定位。脚本不解析聊天、不读取 raw 内容、不核验语义结论、不执行 Git 写入或网络请求。

## 输入与两步生成

输入与观察快照均放在当前仓库 `.local/` 下。脚本要求显式 repo 根（含 `.git` 文件或目录）；输入的 worktree/branch/HEAD 是历史观察值，不自动替换为执行机器当前身份。

在 PowerShell 7 中，以下路径由本次实际 Skill 根与 worktree 确定：

```powershell
$helperPath = '<实际 Skill 根>/engineering-workflow/scripts/closeout-archive.mjs'
$repoPath = (Get-Location).Path
$inputPath = Join-Path $repoPath '.local/closeout/005-input.json'
$snapshotPath = Join-Path $repoPath '.local/closeout/005-snapshot.json'
$observation = & node $helperPath observe $repoPath $inputPath
if ($LASTEXITCODE -ne 0) { throw ($observation -join "`n") }
[System.IO.File]::WriteAllText($snapshotPath, ($observation -join "`n"), [System.Text.UTF8Encoding]::new($false))
& node $helperPath generate $repoPath $snapshotPath
if ($LASTEXITCODE -ne 0) { throw 'Archive generation failed' }
```

`observe` 只 stat 明确列出的本机文件，将结果作为 JSON 输出；调用者先设置真实 UTC `observed_at`，再保存成功输出。它不写 archive、不读取 raw 字节；不支持 URL、UNC 网络路径。`generate` 只消费保存的观察，不再次探测 runtime：相同快照始终产生相同 Markdown，即使本机 evidence 后来消失。刷新证据需明确重新 observe，不能把旧快照说成当前事实。两个命令失败均输出 JSON error，exit 1；成功 exit 0。

`generate` 仅写 `.workflow/history/<ticket>.md`，stdout 返回相对路径和 SHA-256。ticket 仅允许字母、数字、下划线和连字符（最多 64 字符，排除 Windows 设备名）。输入/输出各最多 64 KiB，单行文字最多 1000 字符，数组最多 32 项；额外字段、缺少字段、非法路径、链接输出目录/文件均拒绝。同目录临时文件写齐后替换，失败保留已有 archive；相同内容不重写。调用者保证单 writer，工具不提供对抗并发路径替换的 OS 隔离。

## Schema v1

所有字段必填；只接受下列键。示例中的身份和时间必须替换为真实事实；未知 ID/model/reasoning 用 `null`，未记录 runs/sessions 用 `[]`，不能补造。

```json
{
  "schema_version": 1,
  "ticket": "005",
  "issue": "GitHub #27",
  "sources": ["docs/tickets/workflow-v1.1/005-closeout-archive.md", "docs/specs/emilia-sylvia-workflow-v1.1.md"],
  "observed_at": "2026-09-19T04:00:00.000Z",
  "worktree": "<历史 worktree>",
  "branch": "<历史 branch>",
  "fixed_point": "0000000000000000000000000000000000000000",
  "head": "0000000000000000000000000000000000000000",
  "summary": "本票实现了什么、发生过什么、哪些尚未完成。",
  "stages": {
    "implementation": {"status": "unknown", "summary": "待核对实际 handoff", "sources": [], "sessions": [{"id": null, "runs": [], "model": null, "reasoning": null}]},
    "review": {"status": "pending", "summary": "等待 Emilia 启动 reviewer", "sources": [], "sessions": []},
    "acceptance": {"status": "pending", "summary": "尚未验收", "sources": [], "sessions": []}
  },
  "metrics": {"status": "unknown", "summary": "尚无可核验耗时/调用统计", "sources": []},
  "failures": {"status": "unknown", "summary": "尚未核对失败/重试", "sources": []},
  "findings": {"status": "pending", "summary": "尚未 review", "sources": []},
  "interventions": {"status": "unknown", "summary": "待核对人工介入", "sources": []},
  "delivery": {
    "pr": {"status": "pending", "summary": "尚无 PR", "sources": []},
    "merge": {"status": "pending", "summary": "尚未合并", "sources": []}
  },
  "evidence": [{"id": "run-evidence", "location": null, "status": "unknown", "observed_at": "2026-09-19T04:00:00.000Z", "identity": null}]
}
```

- 通用事实 `status`：`recorded` 表示有来源的记录（不等于成功）；`none` 表示有来源证明没有发生；`pending` 尚待执行；`unknown` 未知；`not-applicable` 不适用。`recorded/none` 必须有至少一个 `sources` 引用。summary 解释实际结果/原因，不能仅写“成功”。
- `stages` 固定 implementation/review/acceptance；每阶段可记录多个 session 及其 runs/model/reasoning。Emilia 直接验收时记录实际命令证据，并在 summary 说明没有 acceptance 模型 session，不编造 ID。
- `metrics.summary` 包含代表性耗时、单位、调用类型/计数及统计范围；未知量明确写未知，样本不外推成整票统计。`findings.summary` 保留 finding ID、open/fixed/verified、修复及验证来源。PR 与 merge 未发生时 pending，发生后填真实 URL/SHA 与回执来源。
- `evidence.location` 为相对 repo 的本机路径或绝对本机路径；`identity` 记录 run/受测 commit/内容标识及过期原因。`available` 仅表示观察时普通文件存在；`missing` 位置不存在；`stale` 是调用者从内容身份/适用性核验得出的过期结论（observe 保留存在文件的 stale）；`unknown` 无法检查、位置未知或不是普通文件；`not-applicable` 不需要 raw 文件，此时 location 必须为 null。文件存在不能自动证明内容仍适用。缺失文件优先记 missing，原失效原因保留在 identity。

## 提交前交接

回读生成文件，对照来源检查证据、统计口径、finding 修复、未完成事项及能力级别；再检查 Git diff 与写集，只纳入轻量 Markdown。JSONL、runtime、原始测试输出和输入快照留本机，不能粘入 summary/sources。工具仅限制格式/体量，不是秘密检测器；Emilia 仍负责精简与隐私核对。

Git 中的 archive 必须包含足以理解过程的摘要，不依赖 raw 可用；它不会升级为动态 source of truth。PR/merge 等后续事实先更新本地输入再生成补记；归档自身提交 SHA 留 post-commit checkpoint，避免循环提交。仍有动作待办时保留 checkpoint 的准确 Next action。生成成功不等于 Review/acceptance 通过，也不授予 commit、push、merge、Issue close 或全局安装权限。

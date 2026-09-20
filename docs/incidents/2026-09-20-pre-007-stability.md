# Pre-007 稳定化记录（2026-09-20）

## 目的

HARNESS-002～006 连续出现若干环境、测试时序与机械命令输入格式问题。单张 Ticket 中把它们判定为“非本票 blocker”是合理的，但重复出现后如果没有明确 owner / maintenance，就会永久污染 full suite 和后续开发。HARNESS-007 开始前统一处理。

## 1. Codex executable discovery 测试偶发 ETIMEDOUT

### 现象

- HARNESS-002、003、004、005、006 的 full suite 多次出现 Codex executable discovery / catalog refresh 的 ETIMEDOUT / CODEX_EXECUTABLE_UNAVAILABLE。
- 同一测试隔离复跑可能全绿，说明失败与 full-suite Windows 负载/进程启动时序相关。
- 生产代码必须继续真实执行 native CLI `--version` 探测，不能为了测试把生产 timeout 随意调大。

### 根因与处理

`codex-executable.test.js` 的 discovery 单测使用复制后的真实 `node.exe` 作为临时 `codex.exe`，而 `resolveCodexExecutable()` 在单次 probe 上有 1.5 秒真实进程启动 timeout。单测验证的是 discovery/cache/替换逻辑，却被 Windows 临时 EXE 启动速度、IO/杀软/CPU 负载影响。

处理：
- `resolveCodexExecutable()` 增加可选 `probeExecutable` 系统边界注入；默认仍为真实 `spawnSync`，生产行为不变。
- discovery 单测注入确定性 PE 文件 probe，只测试 discovery/cache/替换语义。
- catalog/executor 后续真实 child 交互仍保留，不把整个链路 mock 掉。
- 修复后 executable test 连续 3 轮均 4/4 pass。

## 2. task open-pipes 长期红项

### 现象

`root exit with open pipes remains owned and never kills a stale root PID` 经常得到：
- `status = unknown`
- `root_state = exited`
- `pipes_closed = false`
- `completion_reason = null`

旧断言却要求进入 `unknown` 的瞬间已经是 `stream_error`。

### 根因与处理

HARNESS-003 已明确把状态机修成：root exit 但 pipes 尚未 close 时，立刻进入 `unknown` 并继续保留晚到输出；`stream_error` 是 cleanup timer / 后续失败收敛阶段才可能产生的原因。

旧测试把“进入 unknown”和“cleanup 已决定 stream_error”错误地当成同一时间点。

处理：
- 不改当前生产状态机。
- 更新旧断言：初次 `unknown` 时 `completion_reason === null`，并继续验证 pipes 未关闭、不会 kill 已退出 PID、晚到输出可保存、最终正确收敛。
- 修复后该测试连续 3 轮均通过。

## 3. 环境与机械输入格式护栏

已写入根 `AGENTS.md` 与 repo `engineering-workflow`：

- fresh worktree 默认位于 `.local/worktrees/<ticket-or-maintenance>`，不再先建 allowlist 外路径再搬。
- Context Plan / prompt 的代码与测试入口写完整 repo-relative path，不依赖隐含 cwd。
- fresh worktree 先检查/准备依赖；当前宿主无 `rg` 时直接使用 PowerShell/Git fallback，不让每个 model session 重新撞一次。
- 长 Markdown / JSON / PR body 先落临时文件，再通过 `--body-file` 或脚本读取；避免 JS template string → PowerShell here-string/regex → CLI 的多层转义。
- Git revision/range 使用独立参数或先构造变量；纯文本匹配优先 `-SimpleMatch` / `.Contains()`。
- `request_id` 仅对完全相同 protected payload 复用；脚本/cwd/参数改变即使用新的 request id。
- credential-like 安全 fixture 可能触发 `filesystem_*` 的 `SENSITIVE_CONTENT`；已知这类测试源码直接使用 PowerShell 精确行段。
- 小范围 workflow 文档修改必须保留原始换行；禁止用会重写整文件换行的方式制造大 diff。

## 4. 重复 baseline 红项的升级规则

同一 full-suite/baseline 红项：
- 连续出现在两张 Ticket，或
- 两个独立 baseline/full-suite 观测都复现，

就不能继续只标记“非本票 blocker”。

下一 frontier 前必须：
1. 确定性小问题直接 maintenance 修复；或
2. 建立明确 follow-up Issue / owner / 验证入口。

没有 owner 的长期红项不得继续带进下一张 Ticket。

## 5. 最终验证

- executable discovery 定向测试连续 3 轮：每轮 4/4 pass。
- task open-pipes 定向测试连续 3 轮：每轮 1/1 pass。
- 完整 bridge suite：147 tests / 146 pass / 0 fail / 1 skip。
- `npm run typecheck`：exit 0。
- git diff --check：exit 0。

原 HARNESS-002～006 反复出现的 3 个 executable discovery 红项与 1 个 task open-pipes 红项已不再出现在 full suite。

## 6. 本轮边界

这是 HARNESS-007 前的维护，不改变 #47 产品 scope，不启动付费模型，不升级 Astra，也不把环境维护混入 HARNESS-007 实现。

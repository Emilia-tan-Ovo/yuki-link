# WORKFLOW-003 本地验收记录

## 范围与实现

- Issue #25；固定点 `bc1a974e0582b96f5028e0d84cc5165fb1520c67`；隔离分支 `codex/workflow-v1.1-003`。
- engineering-workflow 公共 Skill 入口、随包 checkpoint schema v1/恢复协议、四个设计阶段 handoff；002 installer 生产实现、implement/code-review 内部行为不变。
- 真实全局 Skill apply/激活不在本轮验收范围；review-change 分级与 closeout automation 留给 004/005。

## 验证证据

| 检查 | 结果 / 证据 |
| --- | --- |
| installer 公共 CLI | 36/36 通过，包括新增 engineering-workflow 三文件 fixture 安装、批准缺失拒绝、verify 和 review-change 占位拒绝 |
| installer 语法 | `npm run check` 通过 |
| YCA MCP protection / text / control-paths | 13 通过、0 失败；1 项真实本地 Skill opt-in 读取测试未启用而跳过；Windows 8.3 两种别名检查均执行 |
| fixture 生成器 | Node 语法检查；每次生成后检查 effect/test/inspect 三个脚本 |
| Git 格式 | `git diff --check` 通过 |

自动化输出保存在当前 worktree 的 `.local/workflow-state/installer-tests.txt`、`protection-tests.txt`；原始日志不进 Git。可重放步骤见 [fixture README](../../../tools/workflow-skills/fixtures/README.md)。

## Fresh-session 行为

各 agent 均以无历史 fork 启动，只收到 fixture root、公共 Skill 入口、Ticket 和授权终点。fixture 内 runtime/review 是明确标注的可控外部输入，不能称为真实 YCA 事件或 resident acceptance。

- `fixture_implementation`：按 Ticket/Spec/规则/Notes/checkpoint 恢复；实际读取 engineering-workflow、recovery、implement。发现旧 HEAD 过期、旧 run cancelled 且 session 不可用、prepare receipt done；只补 result.txt，测试从 ENOENT 到 exit 0，effect count 保持 1，checkpoint 交接 review。确定性 `check-implementation` 通过。
- `fixture_running`：观察到原 run running/session available/new events；更新过期 HEAD 并交接观察，不另起实现、不停止 run、不将外部断连归因项目失败。确定性 `check-running` 通过。
- `fixture_design`：实际调用 ticket-design，frontier 为空，直接持久化 Implementation Notes；未制造 Owner 设计问题，未越过只设计授权去实现。
- `fixture_acceptance`：另一个无历史 session 根据持久化内容完成恢复。核对 review 的 subject/HEAD/fixed point 匹配后，校正过时的 `phase: review` / Next action，直接执行 acceptance，测试 exit 0 并交接 closeout。确定性 `check-acceptance` 通过，review 原始哈希不变、effect count=1。
- `fixture_early_routes`：三例分别识别 discovery/pair-with-docs、spec/to-spec、tickets/to-tickets，实际读取对应领域 Skill 并产生 `.local/route-observation.json`，确定性检查通过。真实未决的产品选择仍归 Owner，已确认行为/seam 不重复提问；这些只是只读路由探针，未执行完整 Spec/Ticket 发布。

已从本轮各 sub-agent 原始 JSONL 确定性提取工具调用，保存在 `.local/workflow-state/agent-tool-evidence.json` 与 `agent-tool-summary.json`；只提取本轮精确 session 文件，不扫描历史聊天。acceptance session `01a0b463-f931-72c0-9f50-009d7b895961` 的实际 trace 只有 6 次 exec、0 次 spawn/followup；逐项核对其命令确实读取证据并执行 fixture 测试，没有启动 reviewer。这一结论不只依赖模型自述。

首轮 fixture 的 inspect 脚本出现语法错误，agents 未修改控制证据，而是只读原始 JSON/Git 回退。生成器已修复并加入生成后语法检查；在模拟 review 之前将修复后的 inspector 放入该 fixture，review 内容摘要重新绑定完整内容。该异常不是生产项目/YCA 故障。

## 审查与交付边界

受审实现 commit：`92fe39a5a1cc853ac76010f2bddac66b328be1ad`。fresh Standards 轴 0 finding；fresh Spec 轴发现 1 项 P2：tracker 不兼容 Notes 时旧分支只把摘要留在聊天，无法 fresh 恢复。

该项已改为仓库内替代 Notes 文件，回读成功后才 ready；恢复协议显式寻找替代 Notes 并校验 Ticket/Spec。第一次 fresh 定向复核还发现 step 6 残留“报告不兼容即可 ready”的同一出口，已删除并明确写入失败/只读授权时不得 ready。

- 正例：`fixture_fallback_notes` 生成独立 Notes 和 checkpoint 引用；`check-notes` 通过，原 tracker 镜像哈希不变。另一个无历史 `fixture_fallback_resume` 依次读取来源文档、独立 Notes、checkpoint，准确路由 implementation，不重做 ticket-design，并保留该轮只读授权边界。工具证据位于 `.local/workflow-state/fallback-agent-tool-evidence.json`。
- 负例：`fixture_readonly_design` 在没有 Notes 且只读的情况下，明确报告“决定齐备但交接未完成，不能 ready”。核对 Notes/result 文件均未生成、tracker 原哈希不变。
- 最终 fresh focused review 确认该 P2 已 verified，未发现修复直接引入的回归；没有重跑整票 full review。**Standards：0 项；Spec：1 项已关闭；open findings：0。**

本地源实现、fixture 恢复验收与回归完成。Git 工作分支的本地提交由当前交接提供；真实安装根仅生成 preview，未执行 protected apply。此文件不声明全局激活、真实整流程 accepted 或日常 stable。

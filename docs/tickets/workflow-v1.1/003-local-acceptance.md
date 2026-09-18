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
- review/acceptance 边界恢复与前三个阶段的路由探针：待完成后补充结果。

首轮 fixture 的 inspect 脚本出现语法错误，agents 未修改控制证据，而是只读原始 JSON/Git 回退。生成器已修复并加入生成后语法检查；在模拟 review 之前将修复后的 inspector 放入该 fixture，review 内容摘要重新绑定完整内容。该异常不是生产项目/YCA 故障。

## 审查与交付边界

fresh Standards / Spec 双轴审查待执行。此文件只记录本地已观察事实，不声明全局激活、真实整流程 accepted 或日常 stable。

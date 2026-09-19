# Workflow Skill 来源

这里是 WORKFLOW-002 管理的版本化 source；用户安装目录是经过批准生成的副本。修改从这里开始，经 preview、明确批准、apply 和 verify 生效。操作与恢复见 [installer 文档](../../tools/workflow-skills/README.md)。

`manifest.json` 列明八个 Skill、完整文件集及可安装状态。六个既有 Skill 按原始字节导入，包含 `agents/openai.yaml`；`.gitattributes` 防止换行转换破坏字节身份。`origins.json` 保存导入时的来源位置、时间及 SHA-256，是历史快照，不是当前安装状态或上游版本声明。上游版本未取得，不能从本机副本推断。

`engineering-workflow` 已由 003 实现，携带 checkpoint 模板和恢复协议；四个设计阶段 Skill 增加持久化 handoff。004 的 `review-change` source 提供 full/focused/evidence 路由并可安装；`implement` 显式区分 workflow 委托与 standalone 默认完整双轴 Review。`code-review` 保留两轴语义，随包提供未提交内容覆盖协议与只读 Git/字节采集 helper；`implement` 随包提供 handoff 模板。

Review 依赖必须来自同一安装根：使用分级工作流时应一并选择 `engineering-workflow,implement,review-change,code-review` 的兼容版本。本工具不递归安装依赖；TDD 等其他 Skill 仍需环境提供。source 实现、确定性 fixture 测试、fresh-agent 行为验收是不同证据层级，见 [fixture 说明](../../tools/workflow-skills/fixtures/README.md)。真实全局安装与 fresh-session 激活需要另行批准，source/fixture 可用不代表已激活或 stable。

005 为 engineering-workflow 增加随包 [closeout archive helper 与输入协议](engineering-workflow/closeout-archive.md)：精简输入/观察快照留 `.local`，仅生成 `.workflow/history/<ticket>.md`。脚本可从安装目录独立运行；生成与证据核对分开，raw 不进入 Git。当前能力声明限于 source 实现，真实 closeout 验收和全局激活由后续事实确认。

当前内容版本由 Git commit 与实际字节摘要共同表示；`schema_version` 仅表示清单格式。后续 source 更新不会自动覆盖全局安装，安装目录改动也不会自动反向导入。导入来源清单保留历史，新内容的可追溯性由 Git 承担。

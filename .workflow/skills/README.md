# Workflow Skill 来源

这里是 WORKFLOW-002 管理的版本化 source；用户安装目录是经过批准生成的副本。修改从这里开始，经 preview、明确批准、apply 和 verify 生效。操作与恢复见 [installer 文档](../../tools/workflow-skills/README.md)。

`manifest.json` 列明八个 Skill、完整文件集及可安装状态。六个既有 Skill 按原始字节导入，包含 `agents/openai.yaml`；`.gitattributes` 防止换行转换破坏字节身份。`origins.json` 保存导入时的来源位置、时间及 SHA-256，是历史快照，不是当前安装状态或上游版本声明。上游版本未取得，不能从本机副本推断。

`engineering-workflow` 已由 003 实现，携带 checkpoint 模板和恢复协议；四个设计阶段 Skill 增加持久化 handoff。`review-change` 仍是 004 的不可安装占位，implement/code-review 内部语义保持既有行为。它们引用的其他 Skills 仍是外部依赖，本工具不递归安装依赖。真实全局安装与 fresh-session 激活需要另行批准，source/fixture 可用不代表已激活。

当前内容版本由 Git commit 与实际字节摘要共同表示；`schema_version` 仅表示清单格式。后续 source 更新不会自动覆盖全局安装，安装目录改动也不会自动反向导入。导入来源清单保留历史，新内容的可追溯性由 Git 承担。

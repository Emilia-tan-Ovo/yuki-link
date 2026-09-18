# 002 — 建立 Workflow Skill 来源与安全应用边界

**Parent:** GitHub Issue #22 — Workflow v1.1

**What to build:** 让 Workflow v1.1 的 Skills 与稳定工作流规则拥有可版本化 source of truth，并能通过明确、可审计的安全流程应用到受保护的 Agent/Skill 环境，而不是让普通文件工具绕过保护直接改写自身指令。

**Blocked by:** None — can start immediately.

**Risk hint:** normal

**Status:** implemented — ready-for-fresh-review（未做真实全局 apply）

## Acceptance criteria

- [ ] 仓库中存在可版本化的 `engineering-workflow`、`review-change` 以及需要调整的现有 Skill source。
- [ ] repo-managed source 与用户安装目录之间的 source of truth / apply / refresh 语义明确。
- [ ] `AGENTS.md` 与 Agent/Skill 安装目录的现有保护边界不被普通 YCA 文件接口绕过。
- [ ] 能以受控方式预览将应用的 diff，并在真正写入受保护位置前保留明确授权边界。
- [ ] 安装/应用后能够重新读取已安装 Skill 并确认版本/内容来自预期 source。
- [ ] 搜索/应用流程不得假定 `rg` 一定存在；需要能力探测或可用 fallback。
- [ ] 不修改用户全局 Codex 配置。

## Implementation-design boundary

安全 apply 采用 repo script、人工批准步骤、专用受控能力或其他方案，由 ticket-design 决定。

## Implementation Notes

2026-09-18：ticket-design 完成，**ready for implementation**。以下实现级选择依据本轮 Owner 授权在已确认 Spec / decisions 边界内收敛，不代表另行获得实现或全局安装授权；验收项仍未完成。

### 调查证据

- 调查基线：`codex/workflow-v1.1-002`，HEAD / fixed point 均为 `a28c0b902fbc4fc2efe0c0a2f5fae8c5f1e6711e`，开始时工作区干净。[GitHub Issue #24](https://github.com/Emilia-tan-Ovo/yuki-link/issues/24) 正文与本票修改前一致，无评论。已按本票 → 正式 Spec → confirmed decisions → AGENTS / CONTEXT / architecture → 代码与测试 → 安装目录的顺序调查；未发现独立 ADR、其他工程标准或 tracker 配置文件。
- 已安装 `~/.agents/skills` 中不存在 `engineering-workflow`、`review-change`；其余六个目标 Skill 均存在。`to-spec`、`to-tickets`、`implement`、`code-review` 还包含 `agents/openai.yaml`，导入不能只复制 `SKILL.md`。已只读核对全部正文与辅助文件；现行 `implement` 仍默认调用完整 `code-review`，现行 `ticket-design` 仍要求末尾确认。本轮以 Owner 明确授权及 confirmed decisions 的“无 Owner 决策则直接形成 Notes”为准，未修改安装版 Skill。
- `tools/codex-session-bridge/src/computer/paths.js:36–43` 只给 Skill **文本读取**开例外，保留 Agent 目录及 `AGENTS.md` / `CLAUDE.md` 的写保护；`:48–70` 检查链接、canonical 路径与 Windows 别名。`README.md:182–184` 明确该保护不是通用 PowerShell 或同用户进程的 OS 沙箱，不能把脚本访问能力误当成安装授权。
- 现有 precedent：`src/computer/filesystem.js:69–99` 的 expected hash、写前复核与替换；`tools/control-center/scripts/Prepare-YcaRuntime.js` 的独立 CLI；其 `src/deployment.js` 的来源核验、互斥锁、保留不确定现场。借鉴行为，不复用带有 YCA 安装目录策略或部署副作用的 Module。两处工具均使用 Node ≥24 / ESM / `node:test`。
- 测试 precedent：bridge `test/text.test.js:148–210,236–260,288–308` 覆盖 Skill 读写权限分离、链接及别名；control-center `test/deployment.test.js:87–122` 覆盖未知目录、漂移、锁和 junction。当前 `rg` 不可用，调查实际使用 PowerShell `Get-ChildItem` / `Select-String`；本 worktree 未安装 bridge 的 `node_modules`，本轮不安装依赖、不运行实现测试。

### Implementation frontier 与决策

Frontier 已收敛：source 放置与交付范围、安装 Interface、批准主体、漂移/失败语义、验证 Seam 均在既定边界内解决；**没有待 Owner 决定的阻塞项**。

1. **来源与分票。** source 放在 `.workflow/skills/<name>/`，清单及导入来源说明放在 `.workflow/skills/`；这是普通版本化材料目录，不使用会充当安装位置的 `.agents/skills` / `.codex/skills`，也不以链接连到安装目录。002 导入六个现有 Skill 的完整基线，记录导入时文件清单与原始 SHA-256；为两个新 Skill 建立明确标注尚未交付的 source 骨架，清单标为不可安装，不让占位 Skill 替代可用行为。003 实现 workflow/handoff/checkpoint，004 实现 review routing/implement compatibility，并分别解除对应 source 的不可安装状态。002 验收的是来源到安装核验的闭环，不宣称上述路由已完成。稳定规则继续以仓库 `AGENTS.md` / confirmed decisions 为依据，本 installer 不写 AGENTS、CLAUDE 或全局 Codex config。

2. **最小 Module / Interface。** 在 `tools/workflow-skills/` 建独立 Node ≥24、ESM、优先仅内置依赖的本地工具，公开 `preview` / `apply` / `verify`，同一 Module 隐藏清单、字节比较、路径校验和落盘细节。CLI 是调用者和自动测试共同穿过的主要 Seam；不新增 MCP、HTTP、常驻服务、权限服务或部署动作，不把逻辑塞入 bridge / control-center。需要启动子进程时沿用参数数组、`shell:false`；PowerShell 入口仅用 7，文本明确 UTF-8。

3. **来源身份。** 清单固定可管理的八个 Skill 名称、各自文件相对路径及可安装状态，不接受任意源到任意目标的复制映射、安装 hook 或通配全目录覆盖。版本用 source commit + 内容摘要表达，清单 schema version 与 Skill 内容版本分开。内容摘要覆盖排序后的文件路径与原始字节（包含辅助文件）；不依赖修改时间、版本标签或 `SKILL.md` 单文件。preview 可以展示开发中的 source，但正式 apply 要求所选 source、清单及 installer 均已跟踪且相对记录的 commit 无修改；不要求无关票据文档也干净。后续更新只改 repo source，不从安装目录自动反向同步；实施导入前重新读取安装版，不能把本次快照视为永久事实。

4. **preview 是可审阅的计划。** 输入明确 source 仓库、Skill 选择集、目标安装根；实际用户目标为当前用户的 `~/.agents/skills`，使用时解析并展示真实绝对路径，不硬编码用户名或自动选另一个安装根。只读取目标，可在 `.local/workflow-skill-apply/<plan-id>/` 保存计划和 diff。计划绑定 source / installer 身份、选择集、canonical 目标、目标完整文件清单与每个文件的旧/新 SHA-256（缺失是独立状态）、拟创建目录、写集和恢复材料位置。展示逐文件新增/修改/no-op 与完整文本 diff；不能成功截断后仍允许批准。多出的目标文件作为冲突展示并停止 apply，不静默删除或忽略；无关 Skill 目录不纳管。plan digest 绑定以上内容及展示结果，计划中没有可执行命令正文。

5. **显式批准不是一个自报标志。** 日常 Agent 可以准备 source、preview 和只读 verify；真正写安装目录前，Owner 审阅具体 diff，并明确批准该 plan digest、目标及写集。随后由 Owner 在本机运行所审阅的 installer，或由原生执行器在其明确允许该次受保护写入后执行同一命令。apply 必须显式指定计划及确认摘要，无确认或摘要不符则零安装写入；摘要只绑定批准对象，**不是不可伪造的授权凭证**。批准事实来自 Owner / 原生权限机制，repo JSON 或 `--approved` 自述不能授予权限。原生策略若拒绝或不能表达此次批准，停下交付人工步骤，不能转用 YCA PowerShell、owned task、复制搬移、路径别名或扩大 write roots 绕行。本票不建立可证明“人类点击”的新认证系统，也不承诺抵御恶意同用户进程。

6. **apply 的写入与失败边界。** 取得 canonical 安装根上的排他锁后，从实际 source / installer / 目标重新生成比较并核对已批准计划；任何变化均使计划失效，重新 preview 和批准，不提供 force。源、目标及祖先路径检查包含越界、大小写碰撞、symlink/junction、硬链接、Windows UNC/device/ADS/模糊名和 canonical 别名；目标文件只能由固定 Skill 名及安全相对路径派生。首个安装写入前，在 repo-local 计划目录保存全部将覆盖文件的原始备份及 intent；失败则不开始安装。每次替换前再核对目标和路径，使用同目录临时文件替换，创建文件不覆盖并发出现的文件。锁、临时文件及备份同样属于已展示写集。跨文件/Skill 不承诺原子事务：中断或 verify 失败报告 partial/unknown，保留锁、备份和已完成动作，不自动重试、回滚或清理未知现场。恢复需新 preview 和批准；本票不提供自动删除旧文件、卸载或批量恢复器。

7. **verify / refresh 语义。** apply 完成后独立重读全部目标文件与目录清单，逐字节摘要对比批准的 source，并记录 source commit / digest、plan digest、观察时间和结果；成功回执仅在核验完成后写出。独立 verify 同样重读实际文件，区分匹配、缺失、内容漂移、额外文件及来源不可用，不信任回执或目录名。source 更新、目标被改、目标根或 installer 变化都要求重新 preview；不自动热同步。文件安装成功不等于当前会话已加载新指令：后续 fresh session 需核对实际发现的 Skill 路径并重新读取，重名/旧副本被选中则不算激活成功。不声称现存 session 热加载或一次验证等于 stable。

8. **无 rg 的路径。** installer 根据清单枚举和读取文件，不依赖搜索外部命令；调查/维护文档中的搜索先 `Get-Command rg`，不存在时使用有范围的 PowerShell `Get-ChildItem` / `Select-String`。不为本票安装 rg、改 PATH 或修改全局配置。

### 建议实现顺序

1. 重新核对安装基线，导入完整 source、来源清单及不可安装的新 Skill 骨架；保持六个现有 Skill 的行为和调用元数据。
2. 在临时 fixture 仓库/安装根，以 CLI Seam 先写 preview、verify 与拒绝路径测试，再实现只读计划及内容核验。
3. 用同一 Seam 推进显式确认、漂移检查、备份、互斥、apply 和失败保留；补充批准及人工恢复说明，完成定向和完整工具测试。
4. 复跑相关 YCA 保护回归；实现涉及权限/安装写入，后续按实际风险走 full review，不能用本票 `normal` hint 降级。真实用户目录安装另行批准，安装内容核验与 fresh-session 发现证据分开记录；006 继续承担整体 Workflow 验收。

### 测试 Seam 与必要案例

- **CLI + 临时文件系统为本票主 Seam**：真实子进程退出码、结构化结果、diff 与落盘字节；覆盖新增、更新、no-op、中文/空格/括号路径、辅助 YAML、LF/CRLF/BOM。preview/verify 不能改目标；无明确选择、不可安装 source、无确认或错误摘要均不写入。无 rg 的环境也必须跑通全部流程。
- **批准后漂移**：修改 source/清单/installer、目标内容或文件集、目标根、计划/diff 后拒绝原计划；apply 要求可追溯的干净 source，verify 不能凭伪造或旧回执成功。重复调用重新检查，不以旧成功记录代替当前事实。
- **范围与保全**：未知 Skill/路径穿越/大小写碰撞、链接/硬链接、canonical 别名、Windows 特殊路径均验证；只读读取例外不能成为写入例外。用 fixture 哨兵证明全局 config、AGENTS、非选中 Skills 及目标外文件字节不变；不拿真实用户配置做破坏性测试。
- **故障与并发**：跨 worktree 同安装根锁、备份失败、写入失败、中途停止和读回不符；断言非成功结果、备份可读、现场保留及恢复前不盲重放。内部 OS 故障注入只负责制造条件，断言仍通过公开结果/文件事实，不断言内部函数或 mock 次数。
- **保留已有 YCA 公共 Seam**：复用 bridge 的 HTTP/MCP fixture，证明受保护 Skill 仍可按现有规则读取，写入/移动、AGENTS 写入继续返回 `PROTECTED_PATH`；不改 PathPolicy 来让 installer 通过。全局真实目录 apply 及 fresh-session 加载只能在获准后记录为真实链路验收，fixture 不能替代它。

### Deferred low-risk details 与停止点

- CLI 文件名/参数拼写、JSON 字段命名、错误码命名、diff 渲染库或内部算法、fixture 布局留给 implement；不能改变上述失败分类、哈希绑定、授权与写入范围。无必要新增依赖或抽象层。
- 本票追加 Markdown `Implementation Notes` 与现行 implement 的自由文本票据消费兼容；无需新 tracker 格式。GitHub #24 **需要在获准外部写入后同步同一节**；本轮只读核对，未写远端。同步前实现必须显式读取这个 repo ticket mirror，不能仅依赖仍无 Notes 的 Issue 正文。
- 下一步仅是在 Owner 明确授权后实现 WORKFLOW-002。当前停在 **ready for implementation**；没有创建 source/installer、修改安装目录或全局配置，没有 commit，也没有调用 implement。

## Implementation Handoff

2026-09-18：在本 session 接获明确 implement 授权后完成代码及 fixture 验证。上述 Implementation Notes 保留设计时事实；当前状态以本节及 repo-local checkpoint 为准。验收勾选保留待 fresh review / acceptance，不把 fixture 通过表述为全局安装或日常稳定使用。

- **Git 身份**：分支 `codex/workflow-v1.1-002`，fixed point `a28c0b902fbc4fc2efe0c0a2f5fae8c5f1e6711e`；本节随实现一并提交，精确提交 SHA / HEAD 在提交后写入 `.local/workflow-state/WORKFLOW-002.md`，供 fresh reviewer 重新用 Git 核对。
- **范围**：`.workflow/skills/` 的八项 source/manifest/origins；六项已安装基线的全部 10 个文件原字节保留，新两项 `installable: false`。独立 `tools/workflow-skills/` 提供绑定状态的完整 preview、显式摘要确认、备份/互斥/安全写入、重读 verify 与恢复说明。新增 YCA HTTP/MCP 保护回归，`.gitattributes` 约束 source 原字节和工具 LF。未实现 003/004 行为。
- **最终验证**：`tools/workflow-skills` 的 `npm run check` 全部源文件语法检查通过；`npm test` **34/34 通过，0 skip**。TDD 从 preview、批准闭环、未提交来源拒绝、完整文件集、CLI 参数及多 Skill 回执等失败案例逐步转绿；故障在子进程 OS 文件操作处注入，覆盖备份失败、写入失败、突然退出、读回漂移和跨 worktree 互斥。
- **保护回归**：bridge 的 `text.test.js`、`control-paths.test.js`、新增 `workflow-protection.test.js` 合计 **13 通过、1 skip、0 失败**。跳过的是需显式 opt-in 的真实全局 Skill 读取测试；Windows 8.3 路径案例实际执行 2/2。新增用例证明 source 可经 MCP 编辑，而安装版 Skill、AGENTS/CLAUDE 的写入和双向移动仍报 `PROTECTED_PATH`。
- **不变性**：导入前后 10 个全局 Skill 文件 SHA-256 与 origins 及 repo source 全部一致；两个新 Skill 未安装。相对 fixed point 的 `AGENTS.md`、bridge/control-center 生产代码 diff 为空。未改用户全局 Codex config；本轮所有 apply 都限定在安全 fixture。
- **相关限制**：另一次扩大到旧 `computer.test.js` 的组合测试在进程终止/系统查询相关的 3 项报失败后停滞，已中断该调用。失败项为 partial-output/termination、script-input/query limits、actual PowerShell/native-child timeout；只读诊断确认当前执行环境 `Get-CimInstance Win32_Process` 被拒绝访问，尚未逐项证明全部失败原因。未修改这些既有生产路径、放宽测试或反复重跑；不能宣称整个 bridge 套件全绿。原版 Skill `quick_validate.py` 所需 PyYAML 不可用，未改全局 Python 环境；也未借校验器改写导入 Skill 的既有 frontmatter。
- **tracker**：已使用现有 GitHub mutation 能力尝试将原正文及已确认 Notes 同步到 #24，返回 `403 Resource not accessible by integration`；未扩大权限或改用凭据绕行。远端仍需后续同步，当前实现与 reviewer 必须读取本地 mirror。
- **handoff / next action**：Emilia 以 fixed point、实现 commit、Ticket/Spec/AGENTS、上述测试事实及限制启动 **fresh full review**。本 implementation context 未调用 code-review、未做语义 Review。真实 protected apply、fresh-session Skill 激活验收另行明确批准；本轮不 push、不创建 PR。

本地确定性测试原始输出位于 `.local/workflow-validation/`，不进 Git。实现及使用说明见 [`tools/workflow-skills/README.md`](../../../tools/workflow-skills/README.md)。

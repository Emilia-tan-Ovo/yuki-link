# HERMES-YCA-001 — Hermes 内嵌工程协作与 YER 抽取设计

状态：YER 候选实现与定向验证完成，Implementation Handoff 交 Ticket Main；本地 commit 状态与精确 SHA 见 checkpoint。Review delegated / pending，真实 Hermes 链路 Acceptance pending。

2026-10-04 Owner 后续授权：实施 GitHub #178，普通操作用 Hermes 原生工具，仅抽取受管工程 runtime；Sylvia 使用 `gpt-6-astra/xhigh/fast`，不改全局默认。终点为最小定向测试、本地 commit 与 Implementation Handoff，不执行 Review、push 或部署。下方保留原设计约束及其历史时态，当前交付状态以文末 handoff 为准。

## Goal

以 Hermes Desktop / Emilia 作为主交互运行时，仅从 YCA 抽取工程 workflow/runtime 为 **YER（Yuki Engineering Runtime）**。普通电脑、文件、shell、Git 操作由 Hermes 原生工具在足够时承担，设计最小工程适配：

```
Hermes / Emilia
  ├─ 普通操作 → Hermes 原生工具
  └─ 工程请求 / 工程面板
       ↓ 同机 127.0.0.1 HTTP / Streamable HTTP
      YER managed workflow / runtime / projection
       ↓
      Codex (Sylvia) / 后续 DSH 等工程后端
```

Owner 的关键体验目标：工程任务不必再单独打开 Yuki Harness 才能观察；希望在 Hermes 内直接看到 Sylvia/DSH 的工程过程、工具/命令活动、修改文件与 git diff，并能理解 Review/finding/Acceptance 状态与恢复同一个 durable run。

## Confirmed constraints

- Hermes 是新的通用 Personal Agent Runtime 主体。
- YER 保留 durable work items、managed workflow launcher、Review/finding/Acceptance 生命周期、session/run 持久化、权限冻结、recovery/reconcile、工程 event/diff projection 与 backend dispatch。
- YCA 作为通用电脑 Agent 退出 Hermes 主路径；保留工程内核真正需要的 Git/文件事实读取、路径保护、进程控制与工程长任务证据能力，不等于继续暴露通用电脑工具。
- Hermes↔YER 本机 IPC 固定使用 127.0.0.1 HTTP / Streamable HTTP，不经过公网/tunnel、不依赖代理。模型/GitHub 自身外网连接与这条本地 IPC 分开。
- 优先复用 Hermes 已有 Desktop / Artifacts / tool activity / Projects / diff/worktree UI；不再造第二个完整 Harness。
- 同一工程工作只有一个 execution authority/source of truth；本票不同时启用 Hermes native Codex runtime 与 YER Codex 双派发，不复制工程状态机或让两个 writer 同开原 runtime。
- 普通聊天和确定性机械操作不要无故启动工程模型。
- Yuki Harness 现有历史与诊断价值保留；其数据服务/证据投影属于工程内核。旧 UI 在真实新链路验收前继续 fallback，不在本轮删除、停服或迁移。
- Skills / workflow 要迁移“行为与方法”，不要复制两套状态机。
- Sylvia / Codex 角色线由 Owner 指定使用 gpt-6-astra + xhigh；这是 Sylvia 角色线覆盖，不改变其他 Agent/票的全局默认模型策略。
- Owner native permission 仍为 Full Access；能力权限不扩大本票行为授权。
- 原设计阶段只交付设计；本次已获实现授权，仍不部署、删除旧系统、迁移私密数据或改微信/Live2D/语音。

## Required design questions

1. 如何从 YCA 收缩为 YER，哪些依赖必须保留、哪些通用工具退出？此收缩是否影响 durable workflow 保证？
2. Hermes 如何通过无公网/代理依赖的本机 MCP/HTTP 和薄插件调用 YER，将 durable run/session/work-item/event 投影为 tool activity / artifact / conversation，而不复制状态权威？
3. Hermes 中如何实时看到：
   - Sylvia/DSH 的对话/进度；
   - 工具/命令调用（默认可折叠）；
   - 修改文件列表；
   - 当前/累计 git diff；
   - Review child / finding / acceptance；
   - 断线后恢复到同一个 run。
4. Hermes 现有 Desktop 是否已有可以复用的 diff/worktree/artifact surface？最小 upstream-friendly 扩展点在哪里？
5. Yuki Harness 哪些能力可以退出日常路径，哪些必须作为诊断/历史 fallback 保留？
6. repo-local workflow Skills / AGENTS 如何接入 Hermes Skills，而不把 Persona/USER/MEMORY 和工程规则混在一起？
7. 未来 DSH 与其他 Repository Engineer 如何使用同一事件/展示契约，而不是把 UI 写死为 Codex。

## Sources

- Owner 当前对话确认的方向。
- 2026-10-04 Owner refinement：YER 只承担工程 runtime、普通操作归 Hermes、IPC 仅同机 127.0.0.1；同一 Sylvia 设计工作项继续，destination=main，Owner native permissions。
- [GitHub Issue #178](https://github.com/Emilia-tan-Ovo/yuki-link/issues/178)；已同步为 Hermes 原生普通工具 + YER 工程 runtime 方向，并重新读取确认。
- `C:\Users\KQ_Sh\Desktop\yuki-link\.local\hermes-replacement-sylvia-20261003.md`
- 当前 yuki-link 默认分支固定点 `1b70d076e921915488e5b117a8acc56f5a85e74d`
- 当前本机 Hermes checkout（只读调查，可核其 Desktop/MCP/Artifacts/Projects/diff seams）。

## Deliverable

形成 `docs/implementation-notes/HERMES-YCA-001.md`：
- 主推荐架构与数据/控制流；
- Keep / Adapt / Retire 边界；
- Hermes UI 集成 seam；
- YER MCP/API/event 与 loopback IPC 最小契约；
- 收缩对 durable 保证的影响、必要内部依赖与工程长任务证据边界；
- Skills/workflow 迁移方式；
- 分阶段 implementation plan；
- focused acceptance plan；
- 未知项与真实风险。

没有 Owner 产品决策 blocker 时直接收敛方案，不制造问题要求 Owner 选择。

## Implementation Notes

Canonical 设计与 Context Plan：[HERMES-YCA-001 Implementation Notes](../../implementation-notes/HERMES-YCA-001.md)。覆盖本票全部 Required design questions；新增接口以 Proposal 标明，未声称已实现或完成真实链路验收。

正式 tracker 为 `https://github.com/Emilia-tan-Ovo/yuki-link/issues/178`，原别名 `local:HERMES-YCA-001` 保留；Issue 已同步 YER refinement，远端标题、正文与 Acceptance Criteria 已重新读取确认。

Issue 已将旧 AC1 的“普通机械操作走 YCA direct tools”替换为 Hermes 原生工具，并将原真实链路改为 Hermes→YER→Sylvia。其他工程保证保留，精确验收计划与抽取/本机 IPC 必要检查见 canonical Notes 第 8 节。后续 implementation 必须另获授权，并从受管工作项、Notes、checkpoint 与 fixed point 恢复；本次设计续发不另开工作项或 session。

## Implementation Handoff（2026-10-04）

### 来源与内容身份

- 来源：本 Ticket / `local:HERMES-YCA-001` / [GitHub #178](https://github.com/Emilia-tan-Ovo/yuki-link/issues/178)，canonical `docs/implementation-notes/HERMES-YCA-001.md` 第 1–9 节及 Context Plan；本次未写入 GitHub。
- worktree：仓库 allowlist 内 `.local/worktrees/hermes-yca-001`；branch：`codex/hermes-yca-001`。fixed point 与实现前 HEAD 均为 `1b70d076e921915488e5b117a8acc56f5a85e74d`。
- 初始 tracked diff 为空；初始相关 untracked 仅本 Notes/Ticket。交付包含这两份持久化设计输入及本次实现文件，无其他工作项修改。`.local` 内测试环境、日志和 checkpoint 不进 Git。
- 受测内容为当前工作字节；commit 主题 `feat: 抽取 YER 工程运行时并接入 Hermes 工程面板`。精确提交 SHA、staged blob / 工作字节 SHA-256 清单在 post-commit checkpoint：`.local/workflow-state/HERMES-YCA-001.md` 与其引用的 `HERMES-YCA-001-tests/content-manifest.json`，不在提交内循环写入自身 SHA。

### 实际范围

- `tools/codex-session-bridge/src/engineering/{runtime,main,task-host}.js`：独立工程装配、显式 runtime/allowlist、单 writer、进程关闭与输出收尾；复用工程内核，退出完整 ComputerTools/Companion 装配。`src/mcp.js` / `src/http.js` 只增加可选工程注册/路由入口，默认 YCA 保留。
- `tools/codex-session-bridge/src/engineering/{authority,http}.js`：同一 journal 内记录计划、预览、受信确认、验证 intent/receipt；绑定内容/policy/权限/profile/scope，走原 managed launcher。已有同工作项授权允许合规续发；未知回执查询原 request，task epoch 失效不自动重跑。HTTP/MCP 共享数值 loopback listener 和 runtime owner。
- `tools/codex-session-bridge/src/engineering/projection.js` 与 `src/harness/{changes-source,changes,codex-source,model}.ts`：公开事件/原生来源标签、work item/session/run/实际 model/service tier/权限投影；high water、稳定 cursor、缺口和非 Codex DTO。current diff 按 index 分层；cumulative 仍使用 Ticket baseline；revision 绑定 HEAD/index/worktree，保护/二进制/删除等状态保留。
- `tools/hermes-yer-adapter/`：Agent 仅工程工具 facade；backend 宿主鉴权/CSRF/同源检查、刷新配置与直连 IPC；Desktop SDK pane 展示公开过程、命令、文件/patch、Review/finding/Acceptance、停止/确认及原 run 重连。短 Skill 只路由到目标仓库 workflow。没有迁移 persona、用户记忆或私密配置。

### 测试与证据

下列 Node/npm 命令的 cwd 为 `tools/codex-session-bridge`；插件命令的 cwd 为仓库根。本机日志目录为 `.local/workflow-state/HERMES-YCA-001-tests/`。测试使用假模型 executor，不启动第二条模型线。

| 命令 / 受测范围 | 结果与证据 |
| --- | --- |
| `npm run typecheck` | exit 0；`typecheck.log`。 |
| `npm run build:ui` | exit 0，生成隔离 worktree 的旧 Harness UI，供既有 HTTP 测试读取；未部署。 |
| `node --test test/engineering-runtime.test.js`（前 5 项）及 `node --test --test-name-pattern='trusted implementation' test/engineering-runtime.test.js` | 5/5 + 1/1，均 exit 0；`runtime-final.log` / `implementation-confirmation.log`。覆盖单 writer、未授权/过期/漂移/记录失败门禁、确认一次/同工作项续发/stop/重连、真实窄 PowerShell task、epoch 未知、实际 HTTP/MCP、不可用代理环境下 Python 直连、非 Codex DTO、Notes-bound implementation launcher 与权限/profile。 |
| `node --test test/engineering-changes.test.js` | 1/1，exit 0；覆盖 staged 被 unstaged 抵消时仍分别可见、index-only 及外部 commit/edit 失效、untracked/binary/deleted/protected rename。结果在本次执行回执；无保存的原始日志。 |
| `node --test test/harness-patch.test.ts test/harness-changes.test.ts` | 11/11，exit 0；结果在本次执行回执，无保存的原始日志。最初因缺少 UI build 无 cookie 失败，构建后通过；只收尾了本次测试自己的 runner。 |
| `node --test test/work-item-lifecycle.test.ts test/work-item-review.test.ts test/shutdown.test.js test/permissions.test.js` | 32/33；exit 1。唯一失败为 `shutdown.test.js:166`，停止前 active.codex 断言 `0 !== 1`；其余生命周期/Review/原生权限及关闭用例通过。`inherited-core.log`。 |
| `node --test --test-name-pattern='computer STOP_FAILED' test/shutdown.test.js` | 当前内容与上述 fixed point 的隔离源码都在同处失败；`shutdown-target.log` / `shutdown-baseline.log`。确认非本次引入，原因未继续诊断；未改旧 shutdown 实现或用例。 |
| `.local/adapter-test-venv/Scripts/python.exe -m unittest discover -s tools/hermes-yer-adapter/test -p test_adapter.py -v` | 5/5，exit 0；`adapter-final.log`。真实 loopback、redirect/source 拒绝、未知 POST 不重放、宿主鉴权 fixture/CSRF/scope/配置刷新。依赖仅装项目 `.local` venv；Starlette 的 httpx 弃用提示无测试失败。 |
| `node --test tools/hermes-yer-adapter/test/desktop.test.mjs` | 3/3，exit 0；`desktop-final.log`。公开 SDK mock + React SSR，cursor/过滤缺口/跨 source/cancellation；修正跨连接选择状态和初次分页 high water。 |
| Skill `quick_validate.py` / `node --check` / `git diff --check` | Skill 校验与语法/空白检查通过；这些不代替独立 Review 或 UI 验收。 |

实现 fixture 中曾写错 workflow 断言读取路径（应为 `workflow.current`），修正后通过；同时修正 pane 的 assessment 字段读取并重跑 Desktop 3 项通过。没有运行完整全仓测试套件或压力矩阵。

### Review、限制与下一步

- `review_policy=delegated`，接收方 **Ticket Main**。本 session 未调用 reviewer、未执行 Review，finding 状态 **pending**；不宣称“零 finding”或审查通过。上层应从此 handoff、fixed point、commit、规范与日志创建独立 Review 职责，不继承 implementation 聊天。
- 已知独立问题：上述 fixed-point shutdown fixture 失败待后续诊断；不阻止交付本次候选代码，也不计为本次 Review 结论。
- 真实 Hermes plugin 装载/按钮交互、实际 Sylvia 模型和 native permission、完整 Review→finding→Acceptance、已有 runtime 接管均 **未验收**。fixture host auth/SDK、现有生命周期定向测试和非 Codex DTO 不证明生产链路可用；DSH 执行明确 unsupported。
- SDK 当前没有底层 AbortSignal 请求参数：取消丢弃有界在途结果并阻止续页，socket 依靠超时结束。窗口保留最近 1000 事件，完整历史仍可从 YER 分页读；受信 backend 的 secret 注入与 profile/source 绑定需部署阶段核对。
- 上层先核对 commit/日志和 durable run 终态/usage，再选择独立 reviewer。后续真实验收按 Notes 第 8 节执行；不在本 implementation session 做 Review、push、PR、安装、部署、迁移或停止现有服务。到本地 commit 与此交接即停止。

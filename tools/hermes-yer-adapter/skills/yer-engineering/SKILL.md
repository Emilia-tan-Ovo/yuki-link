---
name: yer-engineering
description: 在 Hermes 中发起、续接或观察 YER 受管工程工作。适用于 Ticket implementation、Review、finding 修复、Acceptance 与中断恢复；普通文件、shell、Git 操作使用 Hermes 原生工具。
---

先读取当前 Ticket、适用 AGENTS、Implementation Notes / Context Plan 与当前 worktree checkpoint。工作项生命周期与阶段职责以目标仓库同根 engineering-workflow/SKILL.md 为准；yuki-link 的版本源是 .workflow/skills/engineering-workflow/。只传持久化引用、当前 delta、fixed point 与具体授权终点。

使用 yer_list_tools 读取已绑定本机 YER 的精确工具 schema，再用 yer_call_tool 调用。缺服务、身份不符或模型不可用时报告真实缺口；不启动另一套 runtime，也不改全局模型/权限默认。

- 登记 Ticket 时显式提供绑定 worktree 与 immutable fixed point；local alias / Issue URL 不代替返回的 Ticket UUID。
- 从 snapshot、work item、原 request receipt 与 prepare_ticket_resume 恢复事实，完成仓库要求的确定性 preflight。已有 active run 只观察；unknown 先查询原 request 并 reconcile。
- 现有有效 authority 内使用 start_workflow_agent，服务端决定 fresh / continue / replace 与 Main / child。同职责续发携带原 work-item ID/revision 和 authority reference。
- 需要新授权时用 propose_engineering_action 保存完整工程计划；向用户给出简短回执和工程面板入口。计划、聊天确认标签或模型参数不构成授权；面板完成受信 preview/confirm 后读取实际 receipt。工程验证计划必须绑定 work item 和当前 content identity。
- 过程来自 journal 公开事件；按 source ID 与分页 cursor 续读。工程面板显示命令、文件、current/cumulative diff、Review/finding/Acceptance；普通 Hermes 操作的日志仍属于 Hermes。
- HTTP/窗口断线只重连原 source 和原引用。运行完成不等于工作项完成或 Review/Acceptance 通过；阶段交接返回持久化 handoff 与真实 commit/test 引用。
- 本实现的非 Codex 后端只支持中性投影契约；DSH 派发尚未实现，返回 unsupported 时停止该派发，不替换模型。

普通操作继续使用 Hermes 原生 Projects、文件和 shell/Git 工具。工程职责通过上述受管入口执行。完整日志留在工程 pane，主聊天只汇报当前状态、下一步和必要的 Owner 决策。

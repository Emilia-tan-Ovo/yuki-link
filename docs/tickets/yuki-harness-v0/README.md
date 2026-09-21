# Yuki Harness V0 · Tickets Handoff

状态：**原 11 张 V0 tracer-bullet Tickets 已完成；真实使用发现 UI 产品化缺口后，Owner 已确认追加 HARNESS-012 / #76。**

Source Spec：[#39 — Yuki Harness V0：工程协作控制台与可追溯观察](https://github.com/Emilia-tan-Ovo/yuki-link/issues/39)

拆票决定：原 11 张 tracer-bullet tickets 已完成 V0 底座与真实链路验收。HARNESS-011 后的真实 Owner 使用暴露出 Conversation-first UI 未产品化的问题；该缺口不重新拆成一组 UI Tickets，而以唯一一张 HARNESS-012 产品化竖切收敛，复用已验证 prototype 与现有 Harness domain/API。

## Tickets

| Ticket | GitHub | Blocked by | Risk hint |
| --- | --- | --- | --- |
| HARNESS-001 — Ticket 登记与首条持久 Conversation | [#40](https://github.com/Emilia-tan-Ovo/yuki-link/issues/40) | None | high |
| HARNESS-002 — YCA 同步电脑调用全过程回看 | [#42](https://github.com/Emilia-tan-Ovo/yuki-link/issues/42) | #40 | high |
| HARNESS-003 — 受管长任务持续记录与历史补齐 | [#43](https://github.com/Emilia-tan-Ovo/yuki-link/issues/43) | #40 | high |
| HARNESS-004 — Recording 失效时的系统级执行门禁 | [#44](https://github.com/Emilia-tan-Ovo/yuki-link/issues/44) | #40, #42, #43 | high |
| HARNESS-005 — Workflow 进度与验收证据进入 Ticket 工作面 | [#45](https://github.com/Emilia-tan-Ovo/yuki-link/issues/45) | #40 | normal |
| HARNESS-006 — Fresh Review 子 Conversation 与隔离关系 | [#46](https://github.com/Emilia-tan-Ovo/yuki-link/issues/46) | #45 | normal |
| HARNESS-007 — 整张 Ticket 的累计 Changes | [#47](https://github.com/Emilia-tan-Ovo/yuki-link/issues/47) | #40 | high |
| HARNESS-008 — 已有运行的观察与停止控制 | [#48](https://github.com/Emilia-tan-Ovo/yuki-link/issues/48) | #44 | high |
| HARNESS-009 — 复用 Control Center 的日常服务管理 | [#49](https://github.com/Emilia-tan-Ovo/yuki-link/issues/49) | #40 | high |
| HARNESS-010 — Windows 登录自启与后台恢复观察 | [#50](https://github.com/Emilia-tan-Ovo/yuki-link/issues/50) | #44 | high |
| HARNESS-011 — V0 真实协作链路汇合验收 | [#51](https://github.com/Emilia-tan-Ovo/yuki-link/issues/51) | #46, #47, #48, #49, #50 | normal |
| HARNESS-012 — Conversation-first UI 产品化 | [#76](https://github.com/Emilia-tan-Ovo/yuki-link/issues/76) | None（#51 已完成） | high |

原 HARNESS-001 ～ HARNESS-011 的 blocking edges 与完成状态以 GitHub 为准；HARNESS-012 / #76 当前无 blocker，并带 `ready-for-agent`。

## Current frontier

- [#40 — HARNESS-001：Ticket 登记与首条持久 Conversation](https://github.com/Emilia-tan-Ovo/yuki-link/issues/40)

当前只有 HARNESS-001 无 blocker，可开始 `ticket-design`。后续 frontier 必须按 GitHub 当前 issue / dependency 状态重新计算，不能把本文件视为永久动态事实。

## Notes

- #39 是 Source Spec / parent reference；本轮未关闭或改写它。
- #41 是发布脚本恢复过程中误建的 HARNESS-001 重复票，已明确关闭；正式 HARNESS-001 为 #40，#41 不参与任何依赖。
- 所有票均保留 V0 范围；Brain API、Memory、DSH / DS 酱、微信、Live2D、ACP 正式迁移等 Deferred / Out of Scope 未混入本轮。
- 下一步仅在 Owner 授权后对当前 frontier #40 执行 `ticket-design`；本次 to-tickets 不包含实现。

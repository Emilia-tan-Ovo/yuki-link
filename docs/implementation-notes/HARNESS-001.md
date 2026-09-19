# HARNESS-001 · Implementation Handoff

- 来源：[正式 Ticket #40 与 Implementation Notes](https://github.com/Emilia-tan-Ovo/yuki-link/issues/40)、[Source Spec #39](https://github.com/Emilia-tan-Ovo/yuki-link/issues/39)、[本地 Spec](../specs/yuki-harness-v0.md)。#41 不使用。
- 身份：分支 `codex/yuki-harness-v0-001`；worktree 为仓库根下 `.local/yuki-harness-v0-001`。fixed point / 实现前 HEAD：`28863a6754bd3eb445361a0e2c42a58369e945cb`。
- 受测内容：实现与测试共 18 个文件，提交前源码 tree 为 `8c5ca648a84bd44488a92ea9c305dcdd8972913c`；本文件是随后增加的交接摘要，不改变受测行为。文件字节清单在当前 worktree 的 `.local/workflow-state/HARNESS-001-tested-content.json`，SHA-256 为 `26f48e90aaf4ad5b84da4c921d208b0dccbcffec82f4b1a41fb1a1447461015f`。

## 修改

- bridge 包内新增 TypeScript Harness，沿用 Node 24 ESM 原生执行、独立 strict typecheck；不加 runtime loader 或前端框架，不重写既有 JS。
- 新增两个 MCP 工具：显式登记 Project/Ticket、关联已有 session 或单个 run；归属重叠返回 attribution mismatch，不静默改票。主 Conversation 跨 session 保持身份，保存切换边界。
- 复用原 manager/RuntimeStore 的 Codex durable events，后台复制至独立追加式 journal；默认不自动过期，重启重建及去重，源不可用仍读已保存前缀。记录失败与采集失败分开显示。
- 新增可选独立 loopback 只读页面，首页按 Project 进入 Ticket，任务/回复/已暴露工具和错误可见；折叠保留来源正文。配置/归属有观察来源，未接入 Workflow/Changes/Acceptance/服务状态保持 unavailable。
- 修改限于 bridge 包的入口装配、工具数量兼容、README、配置与测试；Control Center/Supervisor 生产代码未修改，常驻服务、tunnel、凭据、自启未修改。未前移其他 Harness 票职责。

## 实际验证

环境：Node `v24.18.1`、npm `11.16.0`；TypeScript `5.9.3`。以下命令均在对应工具包目录执行。

| 验证 | 结果 |
| --- | --- |
| 首个公开 MCP 产品红测 | 登记工具缺失，`isError=true`，符合预期；实现后转绿 |
| `node --test test/harness.test.ts test/shutdown.test.js` | 4/4 通过，exit 0；含 3 条 Harness 产品测试与生产启动/关闭回归 |
| `npm run typecheck` | exit 0；包含新增长期 TS 模块和 Harness 测试 |
| 最终 `npm test` | 仅执行一次完整 bridge suite：105 passed、1 skipped、0 failed，exit 0，约 62 秒 |
| Control Center：`node --test --test-name-pattern '^real deployed YCA reports the target commit' test/deployment.test.js` | 仅选择既有实际部署加载场景：1/1 通过，exit 0，约 50 秒；覆盖无编译准备、TS source 装配、真实工具摘要与隔离 YCA 加载 |
| `git diff --cached --check` | exit 0 |
| 真实浏览器可视检查 | **未验证（Computer Use connection failure）**：Chrome 打开及查询均返回 `nodeRepl.fetch request failed`。Owner/Emilia 明确授权保留未验证项后继续提交，不再重试或修改环境 |

产品测试覆盖 UI 离线期间后台保存、源离线后重开读取、后台重启、去重、session 切换、Project 分组、显式归属冲突、持久化失败、损坏尾记录、脱敏标志、只读页面访问保护与转义。完整 suite 的一个 skip 是需显式 opt-in 的真实本机 Skill 读取，与 Harness 无关。

原始日志留本机：`.local/workflow-state/HARNESS-001-bridge-final.log`、`HARNESS-001-deployment-probe.log`。部署测试仅操作隔离临时仓库/服务，不更新正式 origin 或常驻部署。浏览器 fixture 锁指向的进程已不存在，原端口未发现监听；保留现场文件，未强杀、未清锁。

## Review 与交接边界

- Review policy：**delegated**；接收方 **Emilia / engineering-workflow**。本 session 未执行 Review；finding 状态为 pending，不能解释为零 finding 或审查通过。
- 已知限制：真实浏览器可视检查未完成；ChatGPT→YCA 真实链路 Acceptance 未执行；未作 stable 声明。旧源未暴露的正文/历史拒绝/逐条脱敏状态保持 unavailable/unknown。系统级 recording gate 属于 #44，当前候选不具备该门禁。损坏 journal 保留现场而不自动修复；大历史量未作压力测试。
- Commit：本实现与本 handoff 同批提交，主题 `feat: 实现 Harness 首条持久协作对话`；精确 SHA 由提交后 `.local/workflow-state/HARNESS-001.md` 记录，避免文档自引用提交 SHA。
- Review subject：上述 fixed point 到 checkpoint 指向的最终 commit，包含本 handoff；如工作区又有变化，需重新核对，不能只使用旧测试结论。
- 下一步仅由 Emilia 核验 Git 身份与证据，并接手 Review。当前授权终点为本票 commit、handoff 和 checkpoint phase=review；未 push、未开 PR，不进入 Acceptance/closeout。

## F1 修复 Handoff（2026-09-19）

- 原 fresh primary full Review：`.local/workflow-state/HARNESS-001-review.md`，受审 target `5f3b60a72f874b2930fcef1f7412e0756839ab32`；唯一 finding 为 F1 / P2。原 reviewer 在 fresh context 完成 Standards/Spec 两轴，平台 session UUID 未提供，以报告与受审 target 定位，不编造会话身份。
- **F1：fixed，pending focused verification**。只在 Harness 的请求 URL 构造处捕获异常，非法 request-target 返回 HTTP 400 / INVALID_URL，不再逃逸至共享 Node 进程。Host/Origin、cookie、CSP 与正常读取路径不变。
- 新增一个公开 HTTP 回归：原始 TCP 发送 `GET http://[ HTTP/1.1`；断言 400，再通过同一仍存活的 server 读取正常 Ticket，核对 Conversation 身份及标题。修复前明确复现未捕获 `ERR_INVALID_URL`（exit 1），修复后通过。
- 定向验证：`node --test test/harness.test.ts test/shutdown.test.js` **5/5 通过，exit 0**；`npm run typecheck` **exit 0**。日志为当前 worktree 的 `.local/workflow-state/HARNESS-001-F1-red.log`、`HARNESS-001-F1-tests.log`、`HARNESS-001-F1-typecheck.log`。
- 本次未重跑完整 bridge suite、Control Center 矩阵或 full Review。原 full Review 的未受影响结论保留，整票仍 **pending focused verification**，不能把修复测试通过解释为 reviewer 已 verified。
- 写集仅含 `src/harness/server.ts`、`test/harness.test.ts` 和本 handoff。修复提交主题：`fix: 隔离 Harness 畸形请求的 URL 解析异常`；精确 fix commit 与受测内容身份记入提交后 checkpoint。
- 真实浏览器可视检查仍为 **未验证（Computer Use connection failure）**；未重试浏览器。未执行 Review/Acceptance、push 或 PR。
- 下一步由 Emilia / engineering-workflow 发起一次 fresh focused re-review，仅围绕 F1、原报告与原 target 到新 fix commit 的 diff；不重做 ticket-design 或 full Review。

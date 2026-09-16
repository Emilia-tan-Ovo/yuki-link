# Control Center V0 验收记录

2026-09-16，Windows 本机。**代码及本地隔离测试完成；正式部署、登录/休眠及 ChatGPT 验收待授权。** 实际拓扑和配置依据见 [baseline](control-center-baseline.md)，入口/日志/自启/回滚见 [使用说明](../tools/control-center/README.md)。

## 已执行

| 层级 | 方法与结果 |
| --- | --- |
| 控制中心自动测试 | `tools/control-center` 的 `npm.cmd test`：16/16 通过，0 skipped。模拟 native runtime，不调用正式 tunnel、不读取 key。 |
| 既有 Bridge 回归 | `tools/codex-session-bridge` 的 `npm.cmd test`：42/42 通过，0 skipped，包括新增配置保护测试；在保留原有 catalog 修复/测试的当前工作区执行。 |
| 本机隔离进程 | 临时目录、动态端口、真实 Node 24.18.1 / PowerShell 7；重复 YCA 启动保持同一 PID；管理器重建后验证实例 token/创建时间；错误创建时间拒绝停止；模拟 YCA 崩溃后备份自有旧锁并恢复；优雅停止确认退出。未调用模型。 |
| 真正的 Supervisor 崩溃 | 独立 Supervisor 子进程强制退出后重启，继续识别原 YCA PID、不重复启动；第二个管理器因端口占用退出；保存“停止”后再次杀掉/重启 Supervisor，YCA 保持停止。全部为测试实例。 |
| 恢复故障注入 | 连续失败跨管理器重启保持预算，第五次后暂停；手动停止取消恢复；模拟长间隔令旧证据失效并给予宽限；活着的 tunnel 降级不触发重启；任务活动/未知时不盲目重启。 |
| Native adapter | 模拟对应版本的 profile、process metadata、HTTP health/system/status；验证显式复用 ID、禁止 create、PID 复用冲突、状态身份不符、拒绝覆盖自定义 profile；只由原生 connect/stop 负责 tunnel，不另起 daemon。正式 connect/stop 未执行。 |
| 安全与日志 | 错误 Host/Origin、缺 session/CSRF、非 ASCII 伪造 cookie、GET 修改、额外命令参数被拒；诊断无 session/CSRF/YCA token；带假凭据/URL/headers 的日志仅输出固定事件字段；日志轮转通过。 |
| 工具契约 | `src/mcp.js` 未修改；从实际注册生成 14 项，SHA-256 `e876dcb5c870702679e18736867aff2844011af293e36c608a1bd3565f564e0c`。没有新增控制中心 MCP 工具；该数字和摘要是本次计算结果，不是运行时常量。 |
| 自启准备 | 4 个 PowerShell 脚本 AST 解析通过；`Startup.ps1 -Action Preview` 从实际生成的任务对象验证 Interactive/Limited、IgnoreNew、3 次/PT1M、PT0S、允许电池且不因拔电停止、无外网前置、不唤醒；未注册计划任务。 |
| 浏览器 | 本机 7392 观察页面已渲染；正式启停/恢复/自启按钮禁用；显示未受管旧锁和“ChatGPT 未验证”；CLI 检查显示实测版本，复制诊断成功；中文编码已修正。重复打开入口保持同一后台 PID；关闭网页后 HTTP 仍 200、后台存活。 |
| 源码检查 | `node --check`、PowerShell AST、`git diff --check`；新增文件扫描未含真实用户名、连接 ID 或 key。已有无关未提交内容保留。 |

## 待用户确认后验收

1. 正式接管/启动：复验当前状态，备份处理未知旧锁，解除观察模式，使用原 runtime 和原凭据引用启动 YCA/tunnel。验证当前本机官方健康面及只读 MCP 调用。
2. 计划任务真实安装、登录、禁用/卸载与回滚；普通用户任务的实际失败重试/跟踪需要执行后才能判定。桌面快捷方式未创建；目前提供仓库内双击入口与本地网页。
3. 真实休眠/唤醒和物理断网/恢复；自动故障注入只验证策略，不替代这些系统场景。
4. ChatGPT 工具定义核对及一次只读调用；未在此使用 ChatGPT 缓存/旧会话状态作推断。Codex 账号状态与模型调用也未在本控制中心测试中验证。

## 明确保留的边界

- 未受管旧锁、未知实例、不可观测的活动任务、停止超时或孤儿进程，不自动删除/强杀；先保留诊断并暂停。这是 V0 的保守人工处理边界。
- 正式 tunnel 仍停止，因此其 `/ui`、readiness、system 内容只完成对应版本源码核对与模拟测试；不能把它记为正式链路已验收。
- 原生 `runtimes status` 在 baseline 阶段曾隐含尝试远端只读查询；确认源码后不再用作本地轮询。Supervisor 的周期检测不使用该命令，也不使用 doctor。
- 不宣称“Session terminated”、休眠或网络超时中的某一个是本次故障根因。正式退出原因仍未定位。

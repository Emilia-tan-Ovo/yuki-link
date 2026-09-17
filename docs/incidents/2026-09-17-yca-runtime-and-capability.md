# 2026-09-17 YCA 运行时与能力边界事故复盘

## 目的

记录 2026-09-17 实际使用中暴露的运行时缺陷与能力声明偏差。本文只记录已有证据，不把“实现了”扩大成“已长期稳定”。

## 当前真实能力边界

- YCA 的电脑工具主线已能提供 PowerShell、文本/Skills 读取、文件/Git 能力和受管长任务；每项仍以各自票据和实际验收为准。
- YCA → Codex Bridge 已能创建/续聊会话、选择模型与读取结果，但 **YCA-006 完成前，不能宣称该链路已具备正常开发所需的仓库读写/命令权限**。2026-09-17 的真实 YCA 会话中，Codex 仓库读取命令被原生 policy 以 `blocked by policy` 拒绝。
- 上述限制只描述 YCA → Codex 这条链，不等同于用户直接打开 Codex 工作区时的独立权限状态。
- Control Center / YCA / ChatGPT 客户端是不同层：后端工具摘要、Control Center 本机状态和聊天端实际暴露工具必须分别验收，不能互相替代。

## 事故一：Codex Desktop 更新后路径失效

### 现象

Control Center/YCA 保存的 Codex Desktop 原生可执行路径包含版本/构建目录。客户端更新后旧目录消失，Codex 启动失败。

### 根因

把一次发现得到的动态安装路径当成长期稳定配置使用。

### 修复

启动、CLI 检查和 Bridge 能力查询前重新验证配置路径；失效时重新发现当前可用原生 `codex.exe`，并以 `--version` 验证。对应修复已包含在 PR #16。

## 事故二：YCA 已合并新版本但常驻服务仍运行旧 release

### 现象

默认分支已包含新工具，但 Control Center 的 `selected.json` 仍指向旧 release；“重启”只重新启动旧版本。

### 根因

不可变 release / selected 设计具备底层准备能力，但缺少完整、显式的用户更新生命周期；同时普通 restart 与 upgrade 的语义不够清楚。

### 修复

PR #16 增加远端检查、版本准备、显式“更新并重启”，并把“仅重启当前版本”和“启动已选版本”分开。运行中、已选和远端版本分别展示；普通重启锁定当前 commit，不隐式升级。

## 事故三：受控 shutdown 返回 202 后进程未退出

### 现场证据

正式现场在 `deployment-prepared` 后进入停止阶段，Control Center 最终记录 `STOP_TIMEOUT`。YCA 随后表现为 OS 进程仍存在，但本地诊断不可用、activity 不可观测；系统重启后恢复。

### 可复现根因

在隔离 YCA 上：

1. 保持 `activity={codex:0, computer:0, requests:0}`；
2. 只建立一个到 MCP HTTP 端口的底层 TCP 连接，不发送 HTTP 请求；
3. 调用受认证 `/stop`，返回 202；
4. 旧实现 17 秒后进程仍未退出。

该 socket 不计入 MCP activity，也不会被 `closeIdleConnections()` 可靠清理，因此继续持有 Node event loop。

### 修复

`/stop` 先同步进入 drain/closing 状态并发送 202；正常响应等待 `finish`，客户端提前断开则由 `close` 兜底，二者通过一次性调度只触发一轮 shutdown。随后 shutdown 停止监听、关闭 idle HTTP 连接并显式 `closeAllConnections()`，只作用于 YCA 自己拥有的两个 HTTP server。

新增真实子进程回归测试：同时保持一条未计入 activity 的 MCP 裸 TCP socket 和一条 control 裸 TCP socket；客户端必须完整收到 `202 {"stopping":true}`，随后 YCA 在限定时间内正常退出。

## 后续规则

- 动态派生状态必须明确 source of truth、刷新条件、stale/失效语义和环境变化后的测试。
- review 不只检查局部安全约束，还必须覆盖用户完整生命周期，例如“合并新版本以后怎么升级”“接受停止以后进程是否真的退出”。
- 能力说明分为：代码已实现 → 真实链路已验收 → 日常场景已稳定使用。不得跨级描述。
- YCA-006 必须以真实行为验收：ChatGPT → YCA → 同一 Codex session 实际读取、创建/修改文件、执行命令、继续对话并核对结果；模型自述不算通过。

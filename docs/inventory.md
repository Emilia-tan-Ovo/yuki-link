# 本机盘点

盘点日期：2026-09-14。以下是本次本机读取所得，不代表完整磁盘取证或运行可用性验证。

## 已找到的 Yuki Windows 相关位置

| 位置 | 观察 | 结论 |
| --- | --- | --- |
| `%USERPROFILE%\.windows-mcp\start-server.cmd` | 仅提取非敏感的程序路径与模块名，指向下列 A 环境的 `Scripts\python.exe` 和 `windows_mcp` | 已找到本地启动入口；未运行或修改 |
| `%LOCALAPPDATA%\uv\cache\archive-v0\bjejFDkd76l-3P5w\Lib\site-packages\windows_mcp`（A） | Python 包源码；同级 metadata 标记版本 0.8.5 | 启动脚本指向的安装环境中的源码 |
| `%LOCALAPPDATA%\uv\cache\archive-v0\mhVN6dZjJ3Hl7ifi\Lib\site-packages\windows_mcp`（B） | 同版本安装副本 | 不能仅凭存在推断它正在使用 |
| `%LOCALAPPDATA%\uv\cache\archive-v0\y_SmDy-mFZJL2SFX\windows_mcp`（C） | 同版本包缓存 | 可用于本地文件比较；不视为已从上游独立核验的基准 |
| `%APPDATA%\uv\tools` | 顶层仅见 `.gitignore`、`.lock` | 本次没有在这里找到已安装工具源码 |
| `%APPDATA%\tunnel-client\yuki-windows.yaml` | 只确认文件名存在 | 是同名接入的配置线索；未读取内容 |
| `%APPDATA%\tunnel-client\secrets` | 只确认目录名存在 | 未进入或读取 |

包 metadata 自报来源为 `CursorTouch/Windows-MCP`、版本 `0.8.5`、MIT License、Python `>=3.12`。这是本地安装信息，不是联网核验结果。

逐一比对 A、B、C 中的 65 个 Python 文件：三份一致，且全部符合各自 dist-info/RECORD 的 SHA-256 记录。未发现这些文件中的 项目专属标记，也未在此次搜索范围找到独立维护的 Yuki Windows Git 仓库。

A 的 `windows_mcp/__main__.py` SHA-256：

```text
4190D0D26629329E2083EF760CD1A54F733011CC71278141C11573D31A5534B4
```

因此应称其为“Yuki Windows 自定义接入所用的 Windows-MCP 安装代码”，不能据此宣称找到了我们自己修改过的源码 fork。接入层可能包含配置定制，具体内容未检查；独立定制源码也可能位于未覆盖位置。

源码中的工具注册涵盖快照/截图、应用、显示器、键鼠输入、PowerShell、文件系统、剪贴板、进程、注册表、通知等。工具定义存在不代表当前客户端全部暴露或实际可用。本次会话工具清单可见 `yuki_windows` 与 Remote Desktop Commander 两组独立接入，但未调用它们做连通性或控制测试。

## 其他 PC 控制相关位置

| 位置 | 分类与处理 |
| --- | --- |
| `%USERPROFILE%\.desktop-commander-device` | 外部 Desktop Commander 的本地状态线索；仅列出文件名，未读 `device.json` |
| `%USERPROFILE%\.claude-server-commander` | 另一个 Commander 命名的配置/日志目录；不能仅凭名称断言与上述插件同源。未读内容 |
| `D:\tools\openai-tunnel-client\v0.0.14` | 有 `tunnel-client.exe`、`cloudflared.exe`、许可证、归属说明与发行压缩包；属于安装产物线索，未发现源码仓库 |
| `%USERPROFILE%\.windows-mcp` | 启动脚本、日志及用户标识文件；日志和标识未读取 |
| `%USERPROFILE%\Desktop\yuki-repo-guide`、`D:\project\yuki-todo-list` | 已存在的其他 Yuki 项目；未发现与 PC 控制相关的命名线索，本轮不纳入或修改 |

Remote Desktop Commander 是 ChatGPT 中连接的外部插件，不属于我们的代码。“官方”是对话中的称呼，本次未核验其发行主体，不能把它描述成由本项目维护或把其文件并入源码。

## 覆盖范围与限制

- 查看用户主目录、桌面、Documents、Downloads；对后面三者进行了有限深度的目录名和 Git 标记搜索。
- 检查 uv 的 Roaming tools 与 Local cache，并递归定位 cache 中的相关包名。
- 对 `D:\project`、`D:\develop`、`D:\tools`、`D:\work`、`D:\resource`、`D:\download`、`D:\backup` 进行了有限深度候选目录搜索。
- 补查 `.cache`、Local Programs、Roaming 中相关名称，跳过依赖目录、常见缓存及重解析点。
- 不全盘扫描文件内容，不读取凭证、设备身份、隧道配置内容或日志，不检查私有会话历史。未核验服务存活、隧道连通、客户端权限或控制行为。

初始化前仓库目标目录不存在，桌面不在其他 Git 工作树内，未发现阻止创建新骨架的目录冲突。

## 维护风险

当前可定位的启动入口依赖 uv cache 中的具体路径。缓存不是长期维护源码的位置；清理或重新生成环境可能使该路径失效。第一张 ticket 应先建立来源清晰、可以重新构建的源码基线，保留现有运行链路供回退。

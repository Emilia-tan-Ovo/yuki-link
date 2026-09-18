# 受审内容协议

code-review 与 review-change 共用此协议；它只定义证据覆盖，不决定 Review 风险级别。

## 捕获与读取

在目标仓库根解析 supplied fixed point 为 SHA，同时记录实际 merge-base 和 HEAD。默认比较 merge-base → HEAD 的 committed 变化，并叠加 HEAD → index、index → worktree 和非 ignored untracked 文件。显式限定 committed-only 时，列明排除内容；implement 的提交前检查必须覆盖全部本票未提交实现。

可用 Node ≥24/Git 时运行本 Skill 随包只读 helper：

```text
node <code-review>/scripts/review-subject.mjs <repo-root> <fixed-point> [previous.json]
```

stdout 是 JSON，exit 0 为 captured/matched，exit 1 为 stale/error。将捕获结果原样以 UTF-8 保存到当前仓库被忽略的 `.local` 证据目录；不要覆盖原报告。helper 连续两次读取 Git 和文件，拒绝采集期间的漂移；不会锁住其他 writer，所以审查结束仍需再次核验。

JSON 记录 fixed point/merge-base/HEAD、index 摘要、全部 tracked 工作字节/缺失/符号链接身份、untracked 清单及 SHA-256、三层 patch 和整体 digest。patch 的 binary 内容与 untracked 原文须按实际需要查看，不能把哈希当作已读内容。符号链接摘要只绑定链接文字，不证明目标内容。冲突、submodule/特殊文件或输出超限会显式失败，另行建立该范围证据后才能继续，不能跳过。

缺少 helper 运行环境时用 Git 和文件工具取得同等证据：`git diff --no-ext-diff --no-textconv <merge-base> HEAD`、`git diff --cached`、`git diff`、`git ls-files --others --exclude-standard -z`，加所有受检文件/规范/测试依据的字节摘要；说明手工采集方式及局限。文件名按 NUL 解析，不能按空白切分。

两轴必须读取相同的受审对象。记录每个新增/未提交文件属于本票还是无关现场，无关内容明确排除而不删除；相关 ignored 产物（测试报告等）单独列引用与哈希，不扫描凭据/runtime 全目录。即使某层 diff 为空，也检查其他层；所有层均无变化时报告 no-change，不运行两个空 Review。

格式检查覆盖 `git diff --check <merge-base> HEAD`、`git diff --check --cached`、`git diff --check`；新增文件另读并检查。规范和 Spec 若来自仓库外，另附其版本/摘要。测试证据附命令、退出码、受测内容身份与必要环境信息；缺失字段明确 unknown。

## 复核与有效期

完成前再次以同一 SHA 和保存的 JSON 运行 helper。matched 只证明本次采集的 Git/字节相同，不能替代语义审查或证明报告可信。stale/error 则调查差异，重新捕获并补受影响检查；不得给过期对象标 passed。commit 后 HEAD/index 改变，即使最终工作字节相同也会 stale：核对最终内容与原受审内容逐项一致后记录新的 commit 绑定，否则重做受影响检查。

focused re-review 另外固定“修复前”内容身份/commit，取得修后差异；同时保留整票 fixed point 和原 Review 引用，以验证未变部分仍适用。不能把整票高风险 history 当成每次重跑 full 的依据，也不能用局部报告覆盖尚未审查的新变化。

证据不足、内容持续变化或无隔离 reviewer 时交接 incomplete。工作树无需为了采集证据而 commit、stage、stash 或 reset。

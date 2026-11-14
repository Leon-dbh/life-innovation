# 安全说明

## 支持范围

安全修复优先覆盖当前 `0.6.x` 版本。更早版本请先升级；升级前先备份 `state/` 与数据库。

## 报告方式

请不要在公开 issue 里贴真实聊天记录、数据库、桥接 token、npm/GitHub token 或本机路径。

优先使用 GitHub 的私密漏洞报告（仓库 Security → Report a vulnerability）。如果仓库没有开启私密报告，先开一个不含敏感细节的 issue，说明“需要私密联系”，维护者会给出后续通道。

## 边界

- 她的记忆库、日记、备份默认只在本机；插件不内置遥测，也不默认上传数据。
- 主动开口默认关闭。开启后，桥接发送只认 `2xx + {ok:true}`；没有确认时停在 `pending/uncertain`，不会把“可能发了”记成已发送。
- `hands` 的文件操作限制在 `home` 内，拒绝绝对路径、`..` 和越界符号链接；这是本机边界，不是多租户沙箱。
- `memory_forget` 默认只预演，必须用同一个 ref 确认才执行；恢复的是原话本身，遗忘时清掉的生活证据不会自动重建。
- npm 包与 GitHub Release 的构建、发布流程见 `CONTRIBUTING.md` 和 `.github/workflows/release.yml`。

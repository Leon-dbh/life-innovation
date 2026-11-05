# Changelog

> 插件原名 `dsh-jingjing`，从 0.1.0 起叫 `life-innovation`。鲸鲸是她的名字，不是插件的名字。

## 0.1.0 — 2026-11-05

第一个可以装、可以跑、可以搬家的版本。

**人格**
- preset `jingjing-chat`：`persona.complete = true`，系统提示词只有三段事实（名字 / 处境 / 能做的事），不写性格、语气、关系、台词。
- 时间由动态上下文 `jingjing:now` 提供（年月日、星期、钟点），不再把日期写死在 persona 里。

**记忆**
- 五层：原话（`raw_turns`）→ 梗概（`summaries`）→ 要点（`assertions`，带 `valid_to` / `superseded_by`）→ 画像（`profiles`）→ 关系（`relations`）。
- 确定性抽取（规则，不为此调模型）；计划带 `due_at`，过期自动失效。
- 每轮经 `ctx.systemPrompt.context` 注入 ≤1200 字记忆包（order 900），指纹缓存（`lib/packCache.js`），同一状态同一文字，不破坏 prompt cache。
- 回读工具：`memory_find`（≤8 条、每条 ≤200 字）、`memory_read`（`raw:<id>` / `act:<id>`，≤2000 字）。

**日子（真实生活线）**
- `actions` 动作账本：工具调用、写日记等真实动作逐条落库。
- `life_blocks` 由 `raw_turns` + `actions` 聚合，空档就记空档，从不编活动。
- 日记 `diary/YYYY-MM-DD.md`，每条带证据（`raw:1–30` / `act:7`）。
- 安静 ≥20 分钟后 tick 真的写一次日记（先 `pending` 再执行，至少一次）。

**主动开口**
- preset 挂 `@deepseek-ai/dsh-tool-schedule`；她可以给自己上闹钟，到点开口。
- 说明：只会在有会话的地方被唤醒，重启不丢。

**外发账本**
- `outbox` 四态：`pending → sent / uncertain / failed`，单向；没确认一律 `uncertain`。渠道（微信等）留给后续版本，本版不接。

**记得住，也找得回**
- 召回不按时间倒序：CJK bigram 切词 + IDF + 新鲜度 + 情绪权重，`memory_find` 每条带 `score` 和「为什么是它」。
- 淡忘只影响排序：普通记忆 30 天权重减半，带情绪的 7 天减半，原话不删。
- 90 天前的原话归档到 `raw_archive`，id 不变，证据仍然有效。
- 回收站：`recycleRaw` 移出召回，`node tools/restore.mjs --list/--id N` 放回，原 id 能还原就还原。
- `jingjing_status` 只读返回原话/归档/梗概/要点/画像/动作/日子条数、今天的日子、最近一次注入和召回。
- 梗概按「上次梗概之后的新原话」触发，水位用最后一条原话 id，同毫秒不会漏；空日子不写日记。

**工程**
- 单包：仓库根目录就是插件，`dsh.bundle.patch` 指到 `cordis.patch.yml`。
- 安装：`install/install.ps1`（幂等）写 profile、装插件、注册每日备份、写 HKCU Run 自启。
- 守护：`install/service.ps1` + `install/entry.mjs`，web 挂了 5 秒拉起，固定入口 `http://127.0.0.1:60080/`（302 到当前 token 地址）。
- 数据搬家：`tools/export.mjs` / `import.mjs`（`--merge` 合并另一台机器）/ `merge.mjs` / `backup.mjs`。
- 测试：12 个测试文件（memory / life / lifecycle / summaries / tools / outbox / packcache / paths / portability / merge / jsonschema / prompt_policy），`npm test` 全绿；CI 跑 Windows + Ubuntu、Node 22/24。
- Windows 安装脚本目前只做 Windows；macOS / Linux 待补。

**边界**
- 不导入旧项目的库。
- 不做角色扮演提示词；她的性格只能从自己的记忆和模型本身长出来。

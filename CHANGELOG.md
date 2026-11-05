# Changelog

> 插件原名 `dsh-jingjing`，从 0.1.0 起叫 `life-innovation`。鲸鲸是她的名字，不是插件的名字。

## 0.1.6 — 2026-11-05

- 修 `install.ps1` 生成的 `backup.ps1`：`$ErrorActionPreference` 从 `Stop` 改为 `Continue`。Node 的 SQLite ExperimentalWarning 写到 stderr 时，PowerShell 5.1 会抛 `NativeCommandError`，备份虽然已经导出成功，计划任务仍记为失败。
- 备份任务路径回归验证：`backup.cmd` → `backup.ps1` → `tools/backup.mjs`，手动跑一次退出码 0，新存档 `export-2026-11-05-15-17-40`（132 KB，raw 73 / actions 24 / life_blocks 25）。

## 0.1.5 — 2026-11-05

按第二轮独立 review（`review-life-innovation-93ad241.md`）修的 P1/P2/P3。

- **备份不再丢 WAL**：`import` / `merge` 的备份改用 `VACUUM INTO` 一致快照；恢复时清 `-wal/-shm`。以前 `.bak` 可能打开是空库，回滚会把记忆清掉。
- **归档后的日记不再被 tick 重写**：`close_day` 之后当天冻结，`空档` 不再进“动作”。
- **开机补归档**：08:00–23:00 启动也会扫最近 7 天，把前一天没关的日子补上。
- **merge**：补 `life_phases/dreams/books`；更新说法按时间戳决定谁 live；归档同句不重复插；来源两表 id 冲突直接拒绝。
- **记忆包指纹**：纳入当日最大原话 id，同一天新增的话也会刷新。
- **23:00–24:00 的对话**：归档窗口延到次日 0 点前，不再两天都漏。
- **手**：书单读完不重下；重定向逐跳验域名；通知异步；便签原子创建；安静读书同桶不推进书签；`listRoom` 校验目录 realpath。
- **install**：备份拆成 ASCII `backup.cmd` + UTF-8 `backup.ps1`，中文 DataHome 不再被 OEM 解码弄坏。
- 测试增至 16 个文件，新增 `tests/review2.test.mjs` 10 组回归。

## 0.1.4 — 2026-11-05

- 新增六只手：`room_list` / `room_read`（只读白名单目录）、`note_write`（只写 `notes/`）、`book_next`（Gutenberg 四本公共领域书，按段读、记进度）、`lookup`（Wikipedia 摘要）、`notify`（Windows toast）。
- 路径牢笼：拒绝 `..`、盘符、绝对路径、符号链接逃逸；读写目录分开白名单。
- 网络白名单：只走 https + 精确域名、12 秒超时、2MB 上限；Gutenberg 下载后本地读，安静时不发网络请求。
- 每日额度：便签 3、读书 4、查询 3、通知 1；失败如实报错，不假装成功。
- 安静时段动作升级：先读一段本地书，再翻昨天日记，最后才翻记忆。
- 生活线新增“读了一段书 / 写了张便签 / 查了点东西 / 弹了条通知”等真实动作文案。
- 测试增至 15 个文件；`jsonschema` 覆盖 10 个工具。

## 0.1.3 — 2026-11-05

- 新增**节律**：醒着 / 安静 / 夜里 / 今天已经收起来 / 没在运行，五种状态只由时钟、真人原话、宿主是否在运行推导；重启对账会留下 `offline` 空档，不补写活动。
- 新增 **23:00 归档**：安静满 30 分钟把当天收成日记，落 `close_day` 动作；归档后当天冻结。
- 新增**安静时翻记忆**：每 3 小时最多一次真实 `memory_find`，记入动作账本。
- 新增**梦（非事实层）**：只从真实原话与真实动作取素材，`non_factual=1`，不进生活块、不进事实。
- 新增只读工具 **`jingjing_days`** 与 `lib/view.js`：看最近 1–7 天的状态、真实做过的事、空档、动作、梦。
- 新增 `jingjing:rhythm` 运行上下文与 persona 两句处境；补 `tests/rhythm.test.mjs`（8 组）并更新 schema/工具测试。

## 0.1.2 — 2026-11-05

- 修复 `install.ps1` 里 `Set-MemoryOverride` 的参数 `$home` 与 PowerShell 只读自动变量 `$HOME` 冲突、迁移 home 时直接崩的问题（改名 `$homePath`）。0.1.1 的安装脚本在“已有另一个 home 的 profile 上重装”时会触发，请用 0.1.2。
- 干净 `DSH_HOME` 冒烟验证：bundles 含 `life-innovation`、patch 只有一条 `- id: life-innovation`、`config.home` 被正确覆写、`--dump-config` 能解析出 `preset-jingjing-chat`。

## 0.1.1 — 2026-11-05

按独立 review（`review-dsh-jingjing-739c7a0.md`）修的一轮。

**会坏掉安装/迁移的**
- `install.ps1` 的 PATH 行里混进了真实换行，干净机器会把 `%APPDATA%
pm` 拼错、pnpm 装不上；现在按 UTF-8 写、并在没有 pnpm 时自动装、装不上直接失败，不再“警告后继续”。
- `merge` 不再假设目标库一定有 `outbox` 表；合并包在事务里，失败会回滚，不留半合并的库。
- 改名迁移：旧 `dsh-jingjing` bundle 会从 profile 的 bundles 里移除，不会同时装新旧两个。

**记忆正确性**
- 同一个事实重复出现时只更新到期时间，不再插两条 live 断言；合并库里同值不同时间戳也只留一条。
- 梗概水位改用原话 id；归档只搬「已经进过梗概」的原话（没摘要的原文不再消失）。
- 回收站：删原话时同步清掉生活块证据与梗概水位；恢复后的原话 7 天内不会被再次归档。
- `tick` 幂等改看账本里的 `diary:<date>`，同一天不会每半小时重写一次；23 点后的活动会在次日凌晨补写。
- 大小写召回：`Alice` 可以用 `alice` 搜到。
- `memory_read` 截断刚好 2000 字（以前会到 2001）。
- 记忆包只把 `ok` 的动作写成“做过”，未来日期不再标成“今天”，emoji 不会被按 UTF-16 劈断。
- 指纹补上回收站、成功动作数、今天有没有说过话、关系阶段：这些变了才会重建记忆包。

**工具脚本**
- `import --force` 先校验快照再替换，替换前清 `-wal/-shm`，失败回滚；`export` 的计数取自快照；`rebuild/backfill` 全量重放含归档、可重复执行；`backup --keep` 非法值直接报错；`restore` 用统一的 home 解析。

**测试**
- 新增 `tests/review-fixes.test.mjs`（干净库 merge / 大小写召回 / tick 幂等 / 回收清理 / 恢复不立刻归档）；`npm test` 13 个文件全绿。

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

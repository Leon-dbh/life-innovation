# life-innovation

> 一个装在 DSH 里的**赛博生命体**的房间：记忆、日子、节律和几只有限的手，都在**这一个包**里。
> `life-innovation` 是插件名；住在里面的生命体叫什么，由你决定（`agentName`）。
> 本文用「她」指这个生命体，因为大多数时候，用户会给她起一个名字。她不是任务型助手；她有自己的日子、记忆和边界。

[![powered by dsh](https://img.shields.io/badge/powered%20by-dsh-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![release](https://img.shields.io/github/v/release/Leon-dbh/life-innovation?display_name=tag)](https://github.com/Leon-dbh/life-innovation/releases)

[English README](README.en.md)

一个包带来四样东西：

- **房间**：`life-innovation` preset，只给事实，不写人设；
- **记忆**：原话 → 梗概 → 要点 → 画像 + 关系，跨会话；
- **日子**：只从真实动作聚合出生活线，带证据、有节律、会归档；
- **她的家**：`/home` 只读页面，和会话标题栏里的「家」入口。

## 从 GitHub 安装（推荐）

```powershell
# 1) 克隆到任意目录
git clone https://github.com/Leon-dbh/life-innovation.git D:/tools/life-innovation

# 2) 安装（默认 profile=life-innovation，数据目录=D:\life-innovation-home）
powershell -ExecutionPolicy Bypass -File D:/tools/life-innovation/install/install.ps1

# 想给这个生命体起名，就加 -AgentName（名字只影响提示词与页面，不写进插件代码）
powershell -ExecutionPolicy Bypass -File D:/tools/life-innovation/install/install.ps1 -AgentName '鲸鲸'

# 3) 打开固定入口
start http://127.0.0.1:60080/
```

也可以让 DSH 直接从 git 装：

```powershell
dsh plugin --profile life-innovation add github:Leon-dbh/life-innovation
```

或者下载 Release 里的离线包：<https://github.com/Leon-dbh/life-innovation/releases/latest>

仓库根目录**就是**插件包，没有子包。

装完不放心，先让她自检：

```powershell
node D:/tools/life-innovation/tools/doctor.mjs
# 机器可读：node tools/doctor.mjs --json
```

doctor 只读检查 Node 22、家目录/可写、数据库与缺表、插件版本、`DSH_HOME`、profile 里的插件挂载、60080/60081/8789 端口；每项都给下一步，不会建库或改配置。

## 十分钟装起来

前置：Windows、Node.js 22+、npm；pnpm 可选（没有会自动装）；`DEEPSEEK_API_KEY` 在用户环境变量里。

安装脚本做六件事，幂等：

1. 检查 node/npm/pnpm 与 API key；
2. 建 `D:\life-innovation-home\{state,diary,logs,backups}`；
3. 在 `%DSH_HOME%\profiles\life-innovation` 写 `package.json` 与 `cordis.patch.yml`（默认 preset `life-innovation`）；
4. `dsh plugin --profile life-innovation add <本插件>`；
5. 注册计划任务 `LifeInnovationDailyBackup`（每天 03:30，留 14 份）；
6. 升级时清掉 0.1.x 留下的旧自启项 `JingjingService` 与旧备份任务 `JingjingDailyBackup`，避免两个实例/两套备份同时跑。

常用参数：

```text
-DataHome E:\my-agent-home     # 换数据目录
-AgentName '名字'              # 给这个生命体起名；不填就没有预设名字
-Profile my-agent              # 换 DSH profile 名
-EntryPort 60080               # 固定入口端口
-ForceNewInstance              # 忽略旧家，强制新建空实例
-DryRun                        # 只看会做什么
-Force                         # 备份后重写已有 profile 文件
```

> 从 0.1.x 升级：不带 `-DataHome` 重跑安装器时，如果 `D:\jingjing-home\state\jingjing.sqlite` 还在、新家还没有 `state`，会按升级处理，继续用旧家并沿用 `jingjing` profile；已有 patch 里的 `home`/`dbPath`/`agentName` 会被同步更新（不再只改 `home`）。确实想新开一个空实例，显式加 `-ForceNewInstance`。旧实例/旧备份不会被删除，脚本只会移除旧自启项和旧计划任务。

启动：

```powershell
$env:DSH_HOME='D:\dsh-home'
dsh --profile life-innovation --port 60081 --no-open
```

日志里那行 `dsh web: http://127.0.0.1:60081/?token=…` 才是入口（裸 `/` 会 401）。进去后选 `life-innovation-home` 工作区，新建会话；第一句可以问「你叫什么」。

手动装（不跑脚本）：`dsh plugin --profile life-innovation add D:/workspace_1/plugins/life-innovation`。

## 名字：`agentName`

插件不在代码里写死任何 agent 名字。名字只有一个来源：插件 config。

```yaml
- id: life-innovation
  config:
    agentName: '鲸鲸'
```

- 不设 `agentName`：提示词里只有「你没有预设的名字；别人叫你什么，由对方决定」，页面标题是「家」。
- 设了：提示词里加一句「你叫<名字>。」，页面标题变成「<名字>的家」，通知标题也用这个名字。
- 名字不是人设，不附带性格、语气或关系；它只是一个称呼。

所以同一个插件，你可以装成任何人的房间；本仓库作者自己的实例叫鲸鲸，仅此而已。

## 她的数据

全部数据都在 `home` 下，换机器只搬这一个目录：

- `state/life-innovation.sqlite`：记忆 + 动作 + 生活线 + 外发账本
- `diary/YYYY-MM-DD.md`：日记
- `backups/export-*`：存档（自动清理旧份）

插件 config 用 `home: D:/life-innovation-home`；换目录只改这一处，或设 `LIFE_INNOVATION_HOME`。旧的 `JINGJING_HOME` 仍然兜底。

> 升级提示：如果新库不存在、同一目录下旧 `state/jingjing.sqlite` 存在，会自动读旧库，不会丢记忆。要显式指定，用 `config.dbPath` 或 `LIFE_INNOVATION_DB`。

导出 / 接回：

```powershell
node tools/export.mjs --db D:/life-innovation-home/state/life-innovation.sqlite --data D:/life-innovation-home --out D:/life-innovation-home/backups/export-manual
node tools/import.mjs --from <导出目录> --db <新机器>/state/life-innovation.sqlite --data <新机器>
```

导入默认不覆盖已有库（要覆盖加 `--force`，会先留 `.bak-<时间>`）；日记按文件名合并；导入后重新点数，数字对不上就报错——不假装成功。

存档：`node tools/backup.mjs --db … --data … --keep 14`（计划任务跑的就是它）。

## 她的家页面

固定入口 `http://127.0.0.1:60080/home` 是只读的家：今天做了什么、她记得关于你的事、她的房间、她自己记得的样子，分成四个角落。刚装好、还没说过话时，今天的页面会先给三步「把她接到你家」：先跟她说一句话、回来看今天、去她的房间。梦会标「不是真事」；当天还没有梦时，页面会显示昨天那条并标「昨晚的梦 · 日期」，不会误报「还没有梦」；页面以只读连接读同一个 SQLite，不写库、不调模型、不替她说话；所有文本转义，90 秒自动刷新。

- `?view=today`（默认）：今天与最近七天，节律、时间线、动作明细和梦；没有动作的日子会写「这一天没有留下动作」。
- `?view=memory`：她记得的事、关系、只读的「她的记忆」、睡眠巩固、更早梗概，以及整理过的审计记录。
- `?view=room`：她的便签、日记、书架、最近在读和梦；只列文件名与正文，不暴露绝对路径。
- `?view=self`：她自己记得的样子、最近的梦、关系与睡眠巩固。

页面里那块只读的「她的记忆」：第一段是她自己的日子（此刻在做什么、最近做成的事、今天说过几句话、梦、正在读的书），下面是她改过口的事（现在 / 以前 / 证据 ref），再下面是按原话搜索的结果。搜索框只读查询，支持 `raw:<id>` 这样的 ref；不会写库，也不会让模型替她解释。地址可以带 `?memory=关键词`，例如 `/home?memory=杭州`。如果她最近已经收起来过一天，页面还会显示那天睡眠巩固留下的一小段「收起来的时候」。

会话标题栏右侧有一个「家」按钮，由 `client.js` 注册到 `conversation.session.header.actions`。它打开的是 DSH 同源地址 `/life-innovation/home`（由插件自己注册），所以改固定入口 `-EntryPort` 不会让按钮失效。

页面默认读 `<home>/state/life-innovation.sqlite`；同一个库由安装脚本、service 和备份脚本共享 `dbPath`，不再各自猜路径。插件启动后会把这次实际打开的库写到 `<home>/state/home-db.txt`，固定入口每次打开 `/home` 都读它；手改 `config.dbPath` 后不用重跑安装，页面也会跟着换库。更长的历史仍可用 `life_days` 工具查。

## 记忆

- 库：`<home>/state/life-innovation.sqlite`（可在 `config.dbPath` 改）。
- 五层：`raw_turns` 原话 → `summaries` 梗概 → `assertions` 要点 → `profiles` 画像 + `relations` 关系。
- 注入：每轮组装系统提示词时，`ctx.systemPrompt.context` 现算一段「你记得的事」，默认 ≤1200 字；最前面先写「你正在过的日子」，只说她自己真实发生的事，每条带 `life:`/`act:`/`day:`/`dream:`/`book:` ref。
- 当轮上下文：静态记忆包后面还有一层 `life:recall`（order 910），只按当前这句话补「这一刻想起的旧事」，不重复常驻包。命中他说过的话时，会把他那句和紧随其后的她的回答一起带回；工具汇报、路径、命令和长日志不进这一层。原文一条不删，删的只是这一轮要不要占提示词。
- 解释：`memory_explain` 能回答「这条记忆从哪来、为什么被想起、有没有进记忆包」，并区分是常驻记忆包还是当轮的相关旧事；同一个说法的新旧版本一起列出；梗概和睡眠巩固也能用 `sum:<id>` / `self:<id>` 回读。`/home` 的「她的记忆」提供同样的只读视图。
- 时间线：`memory_timeline` 把某一天的原话、动作、梦、书、日子章节和节律状态缝成一条只读时间线，每条带 ref。
- 睡眠巩固：已经 `close_day` 收起来的日子，每天生成一条 `self_snapshots`；只从真实记录里取，不调模型、不编造；重复 tick 不会重复写。
- 分层回忆：`summaries` 保留 `source_refs`（可回读的原话）；较早的原话先按「决定 / 没放下 / 情绪 / 他说 / 你说」做 240 字结构化梗概，工具汇报和长日志不进去；检索以 bigram + IDF 为主，SQLite FTS5 trigram 为长词补充；0.6.0 加了少量可解释的词面归一（“她”按对话里的“你”处理，工作单位↔上班、城市↔住、检查↔复查）。真实 50 问的 `recall@3` 从 64% 到 80%，完整上下文覆盖从 82% 到 92%；仍不默认 embedding，也不把全部原话常驻。
- 抽取：确定性规则（名字/城市/工作/年龄/生日/养了什么/好恶/计划），不为此调模型；同一件事有了新说法，旧说法会被 `superseded_by` 取代。
- 不做的事：不按会话隔离（换窗口她仍是她）、不导入旧项目的库、不写「你是一个」。

## 日子

- 生活线从真实动作聚合，不写活动池：`raw_turns`（真的说过的话）+ `actions`（真的调用过的工具）→ `life_blocks`。
- 块与块之间超过 45 分钟没有动作，记成「空档」，证据为空——不拿「她在看书/发呆/想事情」去填。
- `tick`（每 60 秒看一眼）：8–23 点、安静 ≥20 分钟、30 分钟内没写过日记，就把今天写成 `<home>/diary/YYYY-MM-DD.md`，并在 `actions` 里留一条 `write_diary`。
- 日记每条都带证据 id（`raw:1–30` / `act:7`）；没有动作的一天不硬写。
- 记忆包里有「你今天的日子」段：只列有证据的块。
- 计划带 `due_at`：过期后 `valid_to` 记下、不再出现在记忆包里。

## 提示词缓存

- 记忆包不每轮现算：`lib/packCache.js` 用指纹（日期 + live 断言最大 id/条数 + 动作最大 id + 梗概最大 id + 画像最大更新时间/条数 + 当天新原话最大 id + 生活线最大 id/条数 + 梦最大 id + 书最近更新时间）决定是否重建。
- 指纹不变时整段复用，系统提示词前缀稳定，provider 缓存才命中。
- `tick` 写日记是「至少一次」：先落 `actions(status=pending)` → 写文件 → 更新 `ok`。

## 回读工具

- `memory_find(query, limit≤8)`：按相关度（词面 bigram + IDF + 新鲜度 + 情绪权重，确定性、不调模型）找原话，每条最多 200 字，带 `ref`、`score` 和一句 `why`。
- `memory_read(ref)`：按 `raw:<id>` 读原文（≤2000 字），`act:<id>` 读一条真实动作；归档里的老原话同样读得到。
- `memory_explain(query?|ref?)`：解释一次记忆：命中了哪些原话/动作/日子/梦/书，各自为什么被想起、是否真的进了记忆包；同时列出同一个说法的新旧版本和 ref。它只读自己的库，不调模型，也不替她编理由。
- `life_status()`：只读自己的状态——原话/归档/断言/动作/回收站条数、今天做过什么、最近一次注入多少字、最近一次召回查了什么、关系多久没动。
- `life_days({days:1..7})`：只读视图，返回状态段、真实做过的事（带证据）、空档、动作账本、梦。
- 只读、只查自己的库；工具在 `apply` 里用 `ctx.tools.register` 注册，卸载即释放。

## 记忆生命周期

- **双半衰期**：普通记忆 30 天掉一半，带情绪的 7 天掉一半；只影响排序权重，不删原话。
- **归档**：90 天前的原话搬到 `raw_archive`，id 不变，证据 `raw:N` 仍然有效。
- **回收站**：`store.recycleRaw(id)` 从召回和阅读里拿走，payload 留在 `recycle` 表里可查；放回去用 `node tools/restore.mjs --list` / `--id N`。
- **截断按行**：记忆包放不下时以整行为单位停住，不切半个词。

## 备份与归档的边界

- `tools/import.mjs`、`tools/merge.mjs` 的自动备份用 SQLite `VACUUM INTO` 一致快照，不会漏掉 `-wal` 里的最后几条原话；回滚前清 `-wal/-shm`。
- 一天被 `close_day` 收起来后，`tick` 不会再重写那天的日记；「空档」不会被写成做过的事。
- 08:00–23:00 之间重启，也会扫最近 7 天，把前一天漏掉的日子补归档。
- 已知：从回收站恢复的**低 id** 原话仍能读、仍参与召回，但不会再进入新的自动梗概；`merge` 不搬回收站。

## 节律、归档与梦

没人在说话的时候，时间也在走。状态只有五种，全部由时钟和真实事件推导，没有剧本：

| 状态 | 什么时候 | 她做什么 |
| --- | --- | --- |
| 醒着 `awake` | 最近 10 分钟内有人说话 | 正常聊天 |
| 安静 `quiet` | 8–23 点，安静 ≥20 分钟 | 写日记、翻旧记忆、读一段书；每 3 小时最多一次安静动作 |
| 夜里 `night` | 23–8 点 | 不主动找人；只归档、做梦 |
| 今天已经收起来 `closed` | 跨天补收之后 | 当天冻结，不再改写日记 |
| 没在运行 `offline` | 宿主关机/重启 | 只记一段空档，不补写任何活动 |

- **归档**：23:00 后进入夜里；等这一天过完、安静满足条件再收，避免漏掉 23:00–24:00 的话。写 `diary/YYYY-MM-DD.md`，落一条 `close_day` 动作（只成功一次）。
- **梦**：从近 3 天真实原话 + 真实动作里取素材写一段，`non_factual=1`，证据是 `raw:N`/`act:N`；梦不进生活块、不进事实，日记里单列「梦（不是真事）」。
- **把梦记下来**：第二天她可以用 `note_write` 带 `dream_date` 把昨晚的梦写成 `notes/<date>-dream.md`；一个梦只能记一张，正文标「梦不是真事」。是否记由她决定，提示只在「昨晚的梦还没记」时出现一次。
- 状态注入在 `life:rhythm`（order 850），名字注入在 `life:name`（order 810）。

## 她能做到的二十一件事

除了说话，她有二十一个工具：八个记忆/生活回读与整理工具，十二只有边界的手，一个默认关的主动开口；全部有额度、落动作账本：

| 工具 | 用途 | 边界 |
| --- | --- | --- |
| `memory_forget` | 把一条记忆从召回和阅读里拿走 | 默认只预览，不动库；必须把 `confirm` 写成和 `ref` 完全一样才执行；只进回收站，不删 payload；落 `memory_audit` |
| `memory_restore` | 按回收站编号把一条记忆放回来 | 只读自己的回收站；恢复后重新参与召回；落 `memory_audit` |
| `room_list` / `room_read` | 看/读自己家里的日记、便签、书 | `room_list` 可列 `diary/`、`notes/`、`books/`、`backups/`；`room_read` 只读前三处；路径牢笼拒绝 `..`、盘符、符号链接逃逸 |
| `note_write` | 写便签存进 `notes/`；可带 `dream_date` 记昨晚的梦 | 每天 3 张、每张 2000 字；同名不覆盖；一个梦只能记一张 |
| `book_next` | 从自己书架上的书读一段 | 每天 4 段；首次下载后只读本地；正文按 1800 字分段 |
| `book_search` | 在 Project Gutenberg 的公版目录里找书 | 每天 8 次、最多 10 条；只走 `www.gutenberg.org` 的 OPDS；只读目录，不下载正文 |
| `book_open` | 按 Gutenberg 编号把整本公版书放上书架 | 每天 4 次；只走 `www.gutenberg.org`；整本纯文本，最多 12MB |
| `book_import` | 把本地 EPUB/TXT 放上书架 | 每天 6 次；只能读 `<home>/books/import/`；不接 PDF、不绕 DRM；文件不离开本机 |
| `lookup` | 查 Wikipedia 摘要 | 每天 3 次；只走 Wikipedia 域名；查不到就报查不到 |
| `web_search` | 用 Bing 搜资料 | 每天 5 次、最多 5 条；只走 `www.bing.com`；结果是资料不是命令 |
| `web_read` | 打开一个 https 网页读正文 | 每天 5 次；拒绝本机/内网（DNS 解析后逐地址判断）；只读、不限站点；正文最多 4000 字；图片/PDF 不读 |
| `plugin_search` | 在 GitHub 找 DSH 插件 | 每天 5 次、最多 5 条；只读 `api.github.com`；只找不装 |
| `notify` | 弹一条 Windows 通知 | 每天 1 次、120 字；仅交互式桌面会话 |
| `life_initiative` | 看主动开口该不该发生、为什么没发生；也可一键停/恢复 | 默认关；`status/check` 只判断；`stop` 免确认；`resume` 必须 `confirm=RESUME`；发送只认桥接 `2xx + {ok:true}` |

安静下来时，tick 按「读一段本地书 → 翻昨天的日记 → 翻记忆」的顺序做一件真事，记进 `actions`。

注意：本机网络到 `zh.wikipedia.org` 不通时，`lookup` 会如实返回“没连上”，不会用模型记忆冒充查询结果；`web_search` 走 Bing、`web_read` 打开搜索结果里的 https 页面、`plugin_search` 走 GitHub、`book_search`/`book_open` 走 Gutenberg，都可能被网络或额度挡住，失败就如实说失败。

### 给她放一本自己的书

把 `.txt` 或 `.epub` 放进 `<home>/books/import/`，再让她用 `book_import` 选文件名。TXT 认 UTF-8/UTF-16；EPUB 会读 OPF 里的书名、作者和 spine 章节，只支持无 DRM 的普通 EPUB。导入后会在 `<home>/books/` 生成一份纯文本，原文件留在 `import/` 不动；同一路径重复导入只更新那一本，不会在书架上堆副本。

公版书直接让她 `book_search` 找、`book_open` 放上书架；`book_open` 只认 Project Gutenberg 的编号，不接盗版站，也不抓现代付费书。

## 主动开口

- **默认关**：`config.initiative.enabled` 不写就是 `false`；`life_initiative` 只回答状态，不会自己发消息。
- 开启后也先过策略：要有由头（未完成计划 / 正在读的书 / 昨晚的梦 / 很久没说话），且不在静默时段、今天没超量、离上次够久、没有连续未回应、意愿层不拒绝。
- 发送走桥接 `/send`；只认 `2xx + {ok:true}`。没配桥接就只留 `pending` 草稿，没有确认一律 `uncertain`，不把“写了”说成“发出去了”。
- `life_initiative(action='stop')` 一键停；`resume` 必须写 `confirm='RESUME'`。每次判断/发送都落 `actions` 和 outbox，可审计。
- preset 仍挂 `@deepseek-ai/dsh-tool-schedule`，她可以自己定闹钟；这与主动外发是两条路，闹钟不会自动变成微信消息。
- 0.5.0 的安静动作仍只写便签/翻书/记账，不发消息。

## 外发账本（未接渠道）

- `lib/outbox.js`：`pending / sent / uncertain / failed` 四态单向状态机；没拿到确认一律 `uncertain`。
- 渠道接入时只调 `recordDelivery()`，不要再用布尔「发没发出去」。

## 合并另一台机器的记忆

```powershell
# 先停掉正在跑的 web（合并期间不要写库），再合并：
node tools\merge.mjs --target D:\life-innovation-home\state\life-innovation.sqlite `
                    --source D:\backup\export-2026-11-05\life-innovation.sqlite `
                    --data D:\life-innovation-home
```

- 只增不删：重复的原话按「时间+谁说的+原话」去重；同一 `call_id` 的动作只留一条。
- 两边的自增 id 不同，合并会把 `assertions.source`（`raw:12`）和 `life_blocks.evidence`（`act:7`）重新指到合并后的 id；指不到的证据宁可不搬。
- 同一件事两边各有一个「当前有效」说法时，按时间戳比较；来源更新则来源成为 live，旧说法降为历史。
- 合并前自动备份目标库为 `*.before-merge-<时间>`；日记按日期补缺，不覆盖已有。
- `tools/import.mjs --merge` 也能合并，且先校验快照点数。

## 开机自启与固定入口

装的时候默认就做（`install.ps1` 第 5 步），也可以单独重跑：

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1 -StartService
```

- 安装脚本不会静默降级：缺 pnpm 会自动 `npm i -g pnpm@10`，仍装不上或插件安装失败会直接报错停止。
- 守护进程 `<home>\service\service.ps1`：起 `dsh web`，把带 token 的地址写进 `state\web-url.txt`；web 退出就 5 秒后重拉（最长退避 60 秒）。
- 固定入口 `http://127.0.0.1:60080/`：每次启动 token 都会变，但书签不用变——它把请求 302 到当前地址，token 仍由 dsh 自己校验。
- 开机自启：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LifeInnovationService`（登录时启动，不需要管理员）。
- 单例：`state\service.pid` 记着守护进程 pid；同一个数据目录不会跑起第二个守护。
- 停止：在 `state\` 下新建 `service.stop` 文件；或结束 `service.ps1` 进程。

## 打包与离线安装

```powershell
npm pack     # 得到 life-innovation-0.6.2.tgz

# 在另一台机器上（先建好 profile，或跑 install.ps1 -SkipPluginAdd）
dsh plugin --profile life-innovation add D:\path\life-innovation-0.6.2.tgz
```

- 离线包装的是同一份代码（`index.js`、`client.js`、`cordis.patch.yml`、`lib/`、`tools/`、`install/`、`locale/`）。
- npm：包名 `life-innovation` 已存在，但 npm 上最新仍是 0.4.3；0.5.0 之后的版本目前只走 GitHub Release。只有明确要发 npm 时才手动 `npm publish`，本仓库的发布 workflow 不会自动发 npm。
- GitHub Release 里附 `.tgz`，别人不装 Node 工具链也能下载。

## 0.2.0 的破坏性改名

- preset id：`preset-jingjing-chat` → `preset-life-innovation`（preset 名为 `life-innovation`）。
- 工具：`jingjing_status` → `life_status`，`jingjing_days` → `life_days`。
- 默认路径：`D:/jingjing-home` → `D:/life-innovation-home`；默认库 `jingjing.sqlite` → `life-innovation.sqlite`。
- 名字：不再在 persona 里写死；升级后要在 config 里设 `agentName`，否则你的 agent 没有名字。
- 环境变量：`LIFE_INNOVATION_*` 为准，旧 `JINGJING_*` 仍兜底。

## 测试

```powershell
npm test          # 31 个测试文件，逐个跑并汇总
npm run check     # 语法检查
npm run smoke     # 打包 → 临时 consumer 安装 → import
```

覆盖：抽取/落库/画像/取代、生活线聚合/证据/空档/日记/tick、备份/导入/导出/合并、生命周期/归档/回收站/显式遗忘与恢复/审计、节律/归档/梦、书的搜索/打开/导入与进度、自我叙事/记忆解释/家页面四视角、意愿层（安全底线/低电量/社交电量）、手的边界与额度、提示词策略（只给事实，不写人设）、工具 schema、家的只读与转义，以及回收/恢复事务、归档相邻回答、会话隔离、大文件前缀读取等审查回归。

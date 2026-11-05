# life-innovation

> 一个装在 DSH 里的、有记忆和日子的人的房间。
> 人格、记忆、生活线都在**这一个包**里；不是几个插件拼起来的。
> `life-innovation` 是插件名；鲸鲸是住在里面的那个人的名字。

[![powered by dsh](https://img.shields.io/badge/powered%20by-dsh-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![release](https://img.shields.io/github/v/release/Leon-dbh/life-innovation?display_name=tag)](https://github.com/Leon-dbh/life-innovation/releases)


一个包：她的房间（chat preset）、她的记忆（M1）、她的日子（M2）。

## 从 GitHub 安装（推荐）

```powershell
# 1) 克隆到任意目录
git clone https://github.com/Leon-dbh/life-innovation.git D:/tools/life-innovation

# 2) 安装（会自动写 profile、装插件、注册每日备份）
powershell -ExecutionPolicy Bypass -File D:/tools/life-innovation/install/install.ps1 -Profile jingjing

# 3) 打开固定入口（首次会 302 到带 token 的地址）
start http://127.0.0.1:60080/
```

也可以直接让 DSH 从 git 装（不克隆）：

```powershell
dsh plugin --profile jingjing add github:Leon-dbh/life-innovation
```

或者下载 Release 里的离线包：`https://github.com/Leon-dbh/life-innovation/releases/latest`

仓库根目录**就是**插件包，没有子包。

## 十分钟装起来（M3）

前置：Windows、Node.js 22+（本机 24）、npm；pnpm 可选（`npm i -g pnpm@10`，没有它插件安装可能失败）；`DEEPSEEK_API_KEY` 在用户环境变量里。

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

脚本只做五件事，全部幂等：

1. 检查 node/npm/pnpm 与 API key；
2. 建 `D:\jingjing-home\{state,diary,logs,backups}`；
3. 在 `%DSH_HOME%\profiles\jingjing` 写 `package.json`（bundle 带 `life-innovation`）与 `cordis.patch.yml`（默认 preset、模型、关掉 `working_directory`）；
4. `dsh plugin --profile jingjing add <本插件>`；
5. 注册计划任务 `JingjingDailyBackup`（每天 03:30 存档，留 14 份）。

换数据目录：`-DataHome E:\jingjing-home`；只看不改：`-DryRun`；已有 profile 默认保留，`-Force` 才备份后重写。

启动：

```powershell
$env:DSH_HOME='D:\dsh-home'
dsh --profile jingjing --port 60081 --no-open
```

日志里那行 `dsh web: http://127.0.0.1:60081/?token=…` 才是入口（裸 `/` 会 401）。进去后选 `jingjing-home` 工作区，新建会话；第一句可以问「你叫什么」。

手动装（不跑脚本）：`dsh plugin --profile jingjing add D:/workspace_1/plugins/life-innovation`。

## 她的家（M3）

全部数据都在 `home` 下，换机器只搬这一个目录：

- `state/jingjing.sqlite` 记忆 + 动作 + 生活线 + 外发账本
- `diary/YYYY-MM-DD.md` 日记
- `backups/export-*` 存档（自动清理旧份）
- 插件 config 用 `home: D:/jingjing-home`；换目录只改这一处（或 `JINGJING_HOME` 环境变量）

导出 / 接回：

```
node tools/export.mjs --db D:/jingjing-home/state/jingjing.sqlite --data D:/jingjing-home --out D:/jingjing-home/backups/export-manual
node tools/import.mjs --from <导出目录> --db <新机器>/state/jingjing.sqlite --data <新机器>
```

导入默认不覆盖已有库（要覆盖加 `--force`，会先留 `.bak-<时间>`）；日记按文件名合并；导入后重新点数，数字对不上就报错——不假装成功。

存档：`node tools/backup.mjs --db … --data … --keep 14`（计划任务跑的就是它）。

## 记忆（M1）

- 库：`D:/jingjing-home/state/jingjing.sqlite`（可在 config.dbPath 改；环境变量不同则各自为库）。
- 五层：`raw_turns` 原话 → `summaries` 梗概 → `assertions` 要点 → `profiles` 画像 + `relations` 关系。
- 注入：每轮组装系统提示词时，`ctx.systemPrompt.context` 现算一段「你记得的事」，默认 ≤1200 字。
- 抽取：确定性规则（名字/城市/工作/年龄/生日/养了什么/好恶/计划），不为此调模型；同一件事有了新说法，旧说法会被 `superseded_by` 取代。
- 不做的事：不按会话隔离（换窗口她仍是她）、不导入旧项目的库、不写「你是一个」。

## 日子（M2）

- 生活线从真实动作聚合，不写活动池：`raw_turns`（真的说过的话）+ `actions`（真的调用过的工具）→ `life_blocks`。
- 块与块之间超过 45 分钟没有动作，记成「空档」，证据为空——不拿「她在看书/发呆/想事情」去填。
- `tick`（插件里每 60 秒看一眼）：8–23 点、安静 ≥20 分钟、30 分钟内没写过日记，就真的把今天写成 `D:/jingjing-home/diary/YYYY-MM-DD.md`，并在 `actions` 里留一条 `write_diary`——日记本身也是她那天真做过的一件事。
- 日记每条都带证据 id（`raw:1–30` / `act:7`），点得开；没有动作的一天就写「没有动作。这一天就是空的。」
- 记忆包里有「你今天的日子（每一件都真的做过）」段：只列有证据的块。
- 计划带 `due_at`：过期后 `valid_to` 记下、不再出现在记忆包里。
- 验：`node tests/life.test.mjs`（聚合/证据/空档/日记/tick/计划过期）。

## 提示词缓存（M2.1）
- 记忆包不再每轮现算：`lib/packCache.js` 用指纹（日期 + live 断言最大 id/条数 + 动作库最大 id + 梗概最大 id + 画像最大更新时间/条数）决定是否重建。
- 指纹不变时整段复用，系统提示词前缀稳定，provider 缓存才命中；只有新事实/取代/新梗概/画像更新/新动作/跨天才重建。同一句话重复说（「我叫林晚」）不再改指纹。
- `tick` 写日记改成「至少一次」：先落 `actions(status=pending)` → 写文件 → 更新 `ok`；崩溃后重试而不是当已做过。

## 回读工具（M2.1 / M3.2）
- `memory_find(query, limit≤8)`：按相关度（词面 bigram + IDF + 新鲜度 + 情绪权重，确定性、不调模型）找原话，每条最多 200 字，带 `ref`、`score` 和一句 `why`。
- `memory_read(ref)`：按 `raw:<id>` 读原文（≤2000 字），`act:<id>` 读一条真实动作；归档里的老原话同样读得到。
- `jingjing_status()`：只读自己的状态——原话/归档/断言/动作/回收站条数、今天做过什么、最近一次注入多少字、最近一次召回查了什么、关系多久没动。
- 只读、只查自己的库；工具在 `apply` 里用 `ctx.tools.register` 注册，卸载即释放。

## 记忆生命周期（M3.2）
- **双半衰期**：普通记忆 30 天掉一半，带情绪的 7 天掉一半（`lib/lifecycle.js`）；只影响排序权重，不删原话。
- **归档**：90 天前的原话搬到 `raw_archive`，id 不变，证据 `raw:N` 仍然有效；`memory_read`/召回都能访问，只是不再默认挤占候选。
- **回收站**：`store.recycleRaw(id)` 从召回和阅读里拿走，payload 留在 `recycle` 表里可查；放回去用 `node tools/restore.mjs --list` / `--id N`（原 id 空着就放回原 id，证据 ref 不变）。
- **截断按行**：记忆包放不下时以整行为单位停住，不再把「（证据：raw:12」切成半个词。

## 节律、归档与梦（M3.5）

没人在说话的时候，时间也在走。状态只有五种，全部由时钟和真实事件推导，没有剧本：

| 状态 | 什么时候 | 她做什么 |
| --- | --- | --- |
| 醒着 `awake` | 最近 10 分钟内有人说话 | 正常聊天 |
| 安静 `quiet` | 8–23 点，安静 ≥20 分钟 | 可以写日记、翻旧记忆；每 3 小时最多一次 `memory_find`，落真实动作 |
| 夜里 `night` | 23–8 点 | 不主动找人；只归档、做梦 |
| 今天已经收起来 `closed` | 23:00 归档之后 | 当天冻结，不再改写日记 |
| 没在运行 `offline` | 宿主关机/重启 | 只记一段空档，不补写任何活动 |

- **23:00 归档**：安静满 30 分钟才收；写 `diary/YYYY-MM-DD.md`，落一条 `close_day` 动作（只成功一次）。归档后当天冻结。
- **梦**：夜里归档后，从近 3 天真实原话 + 真实动作里取素材写一段梦，`non_factual=1`，证据是 `raw:N`/`act:N`；梦不进生活块、不进事实，日记里单列「梦（不是真事）」。
- **只读视图**：工具 `jingjing_days({days:1..7})` 返回状态段、真实做过的事（带证据）、空档、动作账本、梦。

状态注入在 `jingjing:rhythm`（order 850），每小时间刷新。

## 手：她能碰到的六件事（M3.6）

除了说话和回忆，她还有六只手，全部有边界、有额度、落动作账本：

| 工具 | 用途 | 边界 |
| --- | --- | --- |
| `room_list` / `room_read` | 看/读自己家里的日记、便签、书 | 只读 `diary/`、`notes/`、`books/`；路径牢笼拒绝 `..`、盘符、符号链接逃逸 |
| `note_write` | 写便签存进 `notes/` | 每天 3 张、每张 2000 字；同名不覆盖 |
| `book_next` | 从 Project Gutenberg 读一段 | 固定四本公共领域书；每天 4 段；首次下载后只读本地 |
| `lookup` | 查 Wikipedia 摘要 | 每天 3 次；只走 Wikipedia 域名；查不到就报查不到 |
| `notify` | 弹一条 Windows 通知 | 每天 1 次、120 字；仅交互式桌面会话 |

安静下来时，tick 会按「读一段本地书 → 翻昨天的日记 → 翻记忆」的顺序做一件真事，记进 `actions`，生活线里能看到“读了一段书”。

注意：本机网络到 `zh.wikipedia.org` 不通，`lookup` 会如实返回“没连上”，不会用模型记忆冒充查询结果。

## 主动开口（M2.1）

- preset 挂 `@deepseek-ai/dsh-tool-schedule`，她可自己定闹钟（`schedule_create/list/update/delete`）。
- 到点由 Host 投递一条 `source.kind='schedule'` 的消息唤醒她；任务与投递记录在 `D:\dsh-home\storages\schedule.json`，重启不丢，过期只补最近一次。

## 外发账本（M2.1，未接渠道）

- `lib/outbox.js`：`pending / sent / uncertain / failed` 四态单向状态机；没拿到确认一律 `uncertain`。
- 渠道接入时只调 `recordDelivery()`，不要再用布尔「发没发出去」。

## 合并另一台机器的记忆（M3.1）

```powershell
# 先停掉正在跑的 web（合并期间不要写库），再合并：
node tools\merge.mjs --target D:\jingjing-home\state\jingjing.sqlite `
                    --source D:\backup\export-2026-11-05\jingjing.sqlite `
                    --data D:\jingjing-home
```

- 只增不删：重复的原话按「时间+谁说的+原话」去重；同一 `call_id` 的动作只留一条。
- 两边的自增 id 不同，合并会把 `assertions.source`（`raw:12`）和 `life_blocks.evidence`（`act:7`）重新指到合并后的 id；指不到的证据宁可不搬，也不留一条点不开的「做过的事」。
- 两边对同一件事各有一个「当前有效」说法时：保留目标库当前那条，另一条降为历史（`valid_to` + `superseded_by`），原文仍可追溯。
- 合并前自动备份目标库为 `*.before-merge-<时间>`；日记按日期补缺，不覆盖已有。
- `tools/import.mjs` 也支持 `--merge`：目标库存在时不再只给「加 --force 覆盖」一个选择。

## 开机自启与固定入口（M3.1）

装的时候默认就做（`install.ps1` 第 5 步），也可以单独重跑：

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1 -StartService
```

- 安装脚本不会静默降级：缺 pnpm 会自动 `npm i -g pnpm@10`，仍装不上或插件安装失败会直接报错停止，不会留下一个「没有记忆」的实例。
- 守护进程 `<home>\service\service.ps1`：起 `dsh web`，把打印出来的带 token 地址写进 `state\web-url.txt`；web 退出就 5 秒后重拉（最长退避 60 秒）。
- 固定入口 `http://127.0.0.1:60080/`（`service\entry.mjs`）：每次启动 token 都会变，但书签不用变——它把请求 302 到当前地址，token 仍由 dsh 自己校验，代理不碰会话内容。
- 开机自启：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\JingjingService`（登录时启动，不需要管理员）。之所以不用计划任务，是 `schtasks /SC ONLOGON` 在普通权限下会被拒绝。
- 单例：`state\service.pid` 记着守护进程 pid；同一个数据目录不会跑起第二个守护（否则两个 node 抢 60081）。
- 收进程树：停 web 时用 `taskkill /T /F` 连 node 子进程一起收，避免「壳退了、端口还占着」。
- 看护代理：`entry.mjs` 退出会被守护重新拉起，固定入口不会静默消失。
- 停止：在 `state\` 下新建 `service.stop` 文件；或结束 `service.ps1` 进程。
- 日志：`logs\service.log`（守护）、`logs\web-<时间>.log`（每次启动的 web 输出）。

## 打包与离线安装（M3.1）

```powershell
# 在插件目录打包
npm pack     # 得到 life-innovation-0.1.0.tgz

# 在另一台机器上（先建好 profile，或跑 install.ps1 -SkipPluginAdd）
dsh plugin --profile jingjing add D:\path\life-innovation-0.1.0.tgz
```

- 离线包装的是同一份代码（`index.js`、`cordis.patch.yml`、`lib/`、`tools/`、`install/`），不是另一套实现；`dsh --profile jingjing --dump-config` 能解析出 `preset-jingjing-chat` 与 `life-innovation`。
- `npm publish`：包名 `life-innovation` 目前未被占用（2026-11-05 查 npm registry），`private` 已设为 `false`；登录后直接 `npm publish` 即可。作者本机 `npm whoami` 未登录，所以没有代发。
- GitHub 上发布 Release 时，把 `npm pack` 出来的 `.tgz` 作为附件一起传，别人不装 Node 工具链也能下载。

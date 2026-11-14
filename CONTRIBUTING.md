# 贡献与发布

## 环境

- Node.js **>= 22**
- 零第三方运行时依赖；新增依赖前先说明它解决的具体问题，不要为了“顺手”引入框架。
- Windows 上的 `.ps1` 必须保存为 **UTF-8 with BOM**，否则 Windows PowerShell 5.1 会解析失败。

## 本地验证

```powershell
npm test          # 逐文件跑 tests/*.test.mjs，失败会继续跑完并汇总
npm run check     # node --check 语法检查
npm run smoke     # 打包到临时目录，安装到临时 consumer，再 import 一次
```

只跑一个方向：

```powershell
node tools/test-runner.mjs --only=initiative
```

测试不得写真实库，也不得调用 live 桥接；需要真实库形态时先用 `VACUUM INTO` 复制只读副本。

## 提交前

- 更新 `CHANGELOG.md`，必要时更新 `PROGRESS.md` 与 `docs/`。
- 跑 `npm test`、`npm run check`、`npm run smoke`；Windows 再跑 `./tools/check-powershell.ps1`。
- 不要提交 `dist/`、`*.tgz`、`state/`、数据库或日志。

## GitHub 发布

发布由手动 workflow 完成：Actions → `release` → Run workflow。

- 版本从 `package.json` 读取；可选输入必须与它一致。
- workflow 会重跑 check/test/smoke，`npm pack`，从 `CHANGELOG.md` 生成 release notes，再用 `GITHUB_TOKEN` 创建 tag + GitHub Release 并上传 tarball。
- 已存在的 tag 不会被覆盖；要发新版先改 `package.json` 与 CHANGELOG。
- workflow **不会**执行 `npm publish`。npm 发布需要单独的安全密钥流程，且要手动确认。

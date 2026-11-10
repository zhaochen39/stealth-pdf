# 发布到 GitHub

## 1. 替换占位符

项目中有两处需要你填写：

- `YOUR_GITHUB_USERNAME`：出现在 `package.json`、`README.md`、`README.en.md`、`.github/ISSUE_TEMPLATE/config.yml` 等
- 许可证与版权署名 `StealthPDF contributors`（`LICENSE`、`package.json` 的 `author` / `copyright`）：可改成你的名字

```bash
# Linux / macOS / Git Bash
grep -rl YOUR_GITHUB_USERNAME . --exclude-dir=node_modules --exclude-dir=.git \
  | xargs sed -i 's/YOUR_GITHUB_USERNAME/你的用户名/g'
```

PowerShell：

```powershell
Get-ChildItem -Recurse -File -Exclude *.png,*.ico | Where-Object { $_.FullName -notmatch 'node_modules|\.git\\' } |
  ForEach-Object { (Get-Content $_ -Raw -Encoding UTF8) -replace 'YOUR_GITHUB_USERNAME','你的用户名' | Set-Content $_ -Encoding UTF8 -NoNewline }
```

## 2. 创建仓库并推送

在 GitHub 新建**空仓库** `stealth-pdf`（不要勾选 README / License），然后：

```bash
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/你的用户名/stealth-pdf.git
git push -u origin main
```

推送后 `ci.yml` 会在 Windows 上自动运行检查、测试和打包验证。

## 3. 发布版本

1. 修改 `package.json` 的 `version`，在 `CHANGELOG.md` 记录变更并提交。
2. 打标签并推送：

```bash
git tag v1.0.0
git push origin v1.0.0
```

`release.yml` 会构建安装包和 zip，并创建 GitHub Release 附上文件。

## 4. 建议的仓库设置

- About：填写描述和主题标签（`pdf-reader` `electron` `windows` `pdf-viewer`）
- 开启 Issues；可开启 Discussions
- 保护 `main` 分支，要求 CI 通过后才能合并
- 在 Security 页启用私有漏洞报告（见 `SECURITY.md`）

## 5. 发布前检查

- [ ] 占位符已替换
- [ ] README 截图与当前界面一致（需要时重新截图）
- [ ] 在真实 Windows 上跑过：触发键绑定与显隐、多标签、保存标注
- [ ] 已在 Windows 上 `npm run dist` 成功
- [ ] `THIRD_PARTY_NOTICES.md` 与依赖一致

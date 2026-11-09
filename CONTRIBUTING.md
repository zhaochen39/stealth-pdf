# 参与贡献 / Contributing

感谢你愿意改进 StealthPDF！

## 开发环境

需要 Node.js ≥ 22.12 和 Windows 10/11（涉及隐身 / 键鼠钩子的改动必须在 Windows 上验证）。

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf.git
cd stealth-pdf
npm install
npm start
npm run check && npm test
```

项目结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 提交 Issue

- Bug：请用模板，附 Windows 版本、软件版本、复现步骤和日志片段（托盘 →「打开日志文件夹」）。提交前先看 [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)。
- 功能建议：说明使用场景，比只说「想要 X」更容易被采纳。
- 安全问题请不要公开提 Issue，见 [SECURITY.md](SECURITY.md)。

## 提交 Pull Request

1. 从 `main` 新建分支，改动聚焦于一件事。
2. `npm run check` 和 `npm test` 必须通过。
3. 新逻辑尽量放在不依赖 Electron 的模块（如 `trigger.js`、`annotate.js`）并补测试。
4. 用户可见的改动同步更新 `README.md`、`README.en.md` 与 `CHANGELOG.md`（Unreleased 一节）。
5. 按 PR 模板填写并自查。

## 代码约定

- 遵循 `.editorconfig`（UTF-8、LF、2 空格缩进）。
- 渲染进程只用原生 JS，不引入构建步骤；第三方库放 `renderer/vendor/` 并附许可证。
- **红线**：不得加入遥测、联网、自动上报，或记录 / 存储按键内容的代码。键鼠钩子只允许用于判断触发状态。
- 提交信息简洁，说明「做了什么、为什么」。

## 行为准则

请友善、尊重地交流；对事不对人。维护者有权删除不当评论并限制违规者参与。

## 许可

贡献的代码以 [MIT](LICENSE) 许可发布。

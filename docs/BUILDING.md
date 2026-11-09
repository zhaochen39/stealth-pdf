# 构建指南 / Building

## 环境要求

- Windows 10/11 x64（构建 Windows 安装包请在 Windows 上进行）
- Node.js **≥ 22.12**（含 npm）
- **不需要** Visual Studio / Python：`uiohook-napi` 自带 win32-x64 预编译二进制，`package.json` 中已设置 `npmRebuild: false`

## 开发运行

```bash
npm install
npm start
```

## 检查与测试

```bash
npm run check   # 语法检查
npm test        # 单元测试（node:test）
```

## 打包

| 命令 | 产物（在 `dist/`） | 说明 |
|---|---|---|
| `npm run pack` | `win-unpacked/` | 仅解包目录，最快，用于自测 |
| `npm run dist:zip` | `StealthPDF-x.y.z-win-x64.zip` | 免安装版，**不需要下载 NSIS 工具** |
| `npm run dist` | `StealthPDF-Setup-x.y.z.exe` | NSIS 安装版（中文向导，可选安装目录） |

`win-unpacked\StealthPDF.exe` 可直接运行，也可整个文件夹压缩分发。

## 常见构建问题

**`connect ETIMEDOUT ...:443`（下载 NSIS / winCodeSign 超时）**
electron-builder 需要从 GitHub 下载工具。任选其一：

1. 设置代理后重试：`set HTTPS_PROXY=http://127.0.0.1:7890`
2. 使用镜像：`set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（Electron 本体可加 `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）
3. 改用 `npm run dist:zip` 或直接使用 `dist\win-unpacked`

**`Could not find any Visual Studio installation`**
确认 `package.json` 的 `build` 中 `npmRebuild`、`buildDependenciesFromSource`、`nodeGypRebuild` 均为 `false`，并重新 `npm install`。

**`Cannot create symbolic link`（winCodeSign 解压失败）**
开启 Windows「开发人员模式」，或以管理员身份运行终端。本项目已设置 `signAndEditExecutable: false` 以尽量避免该步骤。

**改了代码但安装包没变**
删除 `dist/` 后重新打包。

## 重新生成图标

图标源文件是 `build/icon.svg`（大尺寸）与 `build/icon-small.svg`（≤32px 的简化版）。修改后执行：

```bash
pip install cairosvg pillow   # 首次
npm run icons
```

会重新生成 `build/icon.png`、`build/icon.ico`、`build/tray.png`。

## 发布

见 [PUBLISHING.md](PUBLISHING.md)。推送 `vX.Y.Z` 标签后，GitHub Actions 会自动构建并创建 Release。

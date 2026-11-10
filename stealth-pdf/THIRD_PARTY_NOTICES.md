# 第三方组件声明（Third-party notices）

StealthPDF 自身以 [MIT 许可证](LICENSE) 发布。它使用或内置了下列第三方组件，各组件遵循其自己的许可证。

| 组件 | 用途 | 许可证 | 备注 |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) | 桌面应用框架 | MIT | 运行时，随安装包分发（含 Chromium、Node.js，它们各自的许可证见安装目录下的 `LICENSES.chromium.html`） |
| [PDF.js](https://github.com/mozilla/pdf.js) 3.11.174 | PDF 解析与渲染 | Apache-2.0 | 以压缩文件形式内置于 `renderer/vendor/`，许可证全文见 `renderer/vendor/PDFJS-LICENSE.txt` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 把标注写入 PDF | MIT | npm 依赖 |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 嵌入中文字体 | MIT | npm 依赖 |
| [uiohook-napi](https://github.com/SnosMe/uiohook-napi) | 系统级键鼠监听（判断触发键是否按住） | MIT | npm 依赖；包含并静态链接 libuiohook，见下 |
| [libuiohook](https://github.com/kwhat/libuiohook) | uiohook-napi 的底层库 | **LGPL-3.0**（许可证全文见 `node_modules/uiohook-napi/libuiohook/COPYING.LESSER.md`） | 以预编译的 `.node` 二进制形式分发。其源码可在上述链接及 `uiohook-napi` 包内获得；本项目为开源项目，使用者可自行替换为重新编译的版本（见 `docs/BUILDING.md`） |
| [Lucide](https://lucide.dev/) 的 `hand` 图标 | 工具栏「手型」图标 | ISC | 取自 Lucide，已内嵌于 `renderer/index.html` |

开发 / 打包工具（不随应用分发）：electron-builder（MIT）。

应用图标（`build/icon.svg`、`build/icon-small.svg`）为本项目原创，随本项目一并以 MIT 许可证发布。

## Lucide（ISC License）

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

# 架构说明 / Architecture

## 目录结构

```
main.js          主进程：窗口、托盘、设置、IPC、系统钩子与显隐状态机
preload.js       contextBridge，向渲染进程暴露 window.api
trigger.js       触发键模型（纯函数，有单元测试）
annotate.js      用 pdf-lib 把标注写入 PDF（有单元测试）
renderer/        界面：index.html / style.css / renderer.js，vendor/ 为 pdf.js
build/           图标资源（svg 源文件 + 生成物）
tools/           图标生成脚本
tests/           node:test 单元测试
```

## 显隐状态机（main.js `tick()`，每 30 ms）

```
可见 = 隐身关闭
     | 启动 4 秒宽限期
     | 有对话框打开
     | 正在录制触发键
     | 触发键未绑定
     | (触发键按下 且 光标在窗口内)
     | (鼠标键按住 且 当前已可见)
```

- 光标位置来自 `screen.getCursorScreenPoint()`，与窗口 `getBounds()` 比较。
- 隐藏用 `win.hide()`，显示用 `showInactive()` 再 `setOpacity()`，窗口隐藏时不占屏幕、不进任务栏 / Alt+Tab，也不会吞鼠标事件。（早期曾用 opacity 0 + 鼠标穿透，会导致窗口无法点击，已弃用。）
- 触发键状态由 uiohook-napi 的 keydown/keyup/mousedown/mouseup 更新；锁屏 / 恢复时由 `powerMonitor` 复位。

## 触发键模型（trigger.js）

`{ type: 'key' | 'mouse', code: number | null, label }`。`code === null` 表示未绑定。鼠标键编号：3 中键、4 后退、5 前进（左右键不可用）。录制模式下，下一次按键 / 鼠标键被捕获，`Esc` 取消，10 秒超时。键码为 uiohook 的 `UiohookKey` 值（例如 F13–F15 为 91–93，F16 起从 99 开始，并不连续）。

## 渲染进程

- **标签**：全局的 `pdfDoc / curPath / scale / annos` 镜像当前标签；每个标签保存 `{id, path, name, doc, scale, annos, scrollTop}`。切换标签时保存 / 恢复，并用 `buildToken` 丢弃过期的页面构建。
- **页面构建**：每页先建占位，进入视口时才渲染（懒加载）。
- **标注**：坐标以 PDF 页面单位存储，与缩放无关；保存时在主进程交给 `annotate.js`。
- **手型工具**：`pointerdown` 在视图上记录起点，`setPointerCapture` 后用位移更新 `scrollLeft/Top`；中键任何工具下都可平移；点在滚动条上不触发。
- 未保存确认使用页内对话框，而不是系统对话框（系统对话框可能被隐身逻辑隐藏）。

## IPC

| 通道 | 方向 | 作用 |
|---|---|---|
| `pdf:open` | 渲染 → 主 | 打开文件对话框（多选），返回 `[{path,data}|{path,error}]` |
| `pdf:save` | 渲染 → 主 | 写入标注并保存 |
| `open-file` | 主 → 渲染 | 外部（双击 / 命令行）打开的文件数组 |
| `opacity:get/set`、`stealth:get/set` | 双向 | 透明度、隐身开关 |
| `trigger:get/preset/capture/cancel/presets` | 渲染 → 主 | 触发键设置 |
| `trigger-changed`、`open-trigger-dialog` 等 | 主 → 渲染 | 状态同步 |

## 安全边界

`contextIsolation: true`，渲染进程只能通过 `preload.js` 暴露的有限 API 访问主进程；`sandbox: false` 是 preload 需要使用 Node 模块所致。程序不含任何网络请求。键盘钩子的回调只比较编号，不存储按键内容。

## 测试

`npm test` 运行 `tests/*.test.js`：触发键逻辑（匹配、规范化、可录制性）与标注写入。Electron 与真实钩子行为需要在 Windows 上手动验证。

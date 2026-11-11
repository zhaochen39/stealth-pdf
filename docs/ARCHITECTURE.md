# 架构说明 / Architecture

## 目录结构

```
main.js          主进程：窗口、托盘、设置、IPC、系统钩子与显隐状态机
preload.js       contextBridge，向渲染进程暴露 window.api
trigger.js       触发键模型（纯函数，有单元测试）
annotate.js      用 pdf-lib 把标注写入 PDF（含旋转与 CropBox 坐标换算，有单元测试）
pageops.js       页面编辑：旋转 / 删除 / 插入空白页 / 提取 / 合并（有单元测试）
renderer/        界面：index.html / style.css；renderer.js（核心，暴露 window.App）、ribbon.js（功能区）、
                 sidebar.js（缩略图 / 目录）、dialogs.js（页内对话框与菜单）、icons.js；
                 shared/ranges.js（页码范围解析）、shared/annos.js（标注几何，均有单元测试）；vendor/ 为 pdf.js
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

- **标签与窗格**：`tab = { id, panes: [pane], focus, ratio, sync }`，一个标签最多两个窗格。`pane = { path, name, doc, scale, annos, scrollTop, pages, observer, token, drawing, el, viewer, ... }`，每个窗格独立持有文档、缩放、滚动位置和未保存标注。功能区与状态栏的缩放 / 页码 / 撤销 / 保存作用于 `focusPane(activeTab())`。
- **切换标签**：`leaveTab` 记录滚动位置、拆掉 DOM 并递增每个窗格的 `token`（让进行中的页面构建作废）；`showTab` 重新布局并构建各窗格，再恢复滚动位置。
- **分屏**：`#panes` 是 flex 行，两个 `.pane` 中间夹一个 `.splitter`，左窗格宽度由 `tab.ratio` 决定。同步滚动按「滚动增量」传给另一侧（`lastTop` 记账，避免来回触发）。把另一个标签并入时，直接搬运它的 pane 对象（未保存标注随之保留）。
- **页面构建**：每页先建占位，进入视口时才渲染（懒加载）。
- **标注**：坐标以 PDF 页面单位存储，与缩放无关；保存时在主进程交给 `annotate.js`。
- **手型工具**：`pointerdown` 在视图上记录起点，`setPointerCapture` 后用位移更新 `scrollLeft/Top`；中键任何工具下都可平移；点在滚动条上不触发。
- 未保存确认使用页内对话框，而不是系统对话框（系统对话框可能被隐身逻辑隐藏）。

## 功能区与 App 接口

`ribbon.js` 用声明式配置（标签 → 分组 → 按钮）生成功能区，按钮状态（禁用 / 选中 / 文案）由 `refresh()` 在 `App` 的 `change` 事件后统一刷新。功能区、侧栏只通过 `window.App` 调用核心功能（`App.pane()`、`App.setTool()`、`App.rotatePages()` 等），不直接碰内部状态。保留了旧的元素 ID（`btnOpen`、`btnSave`、`btnSplit`、`[data-tool]` 等）。切换功能区标签时对按钮 `mousedown` 做 `preventDefault`，避免清掉文字选区。

主题用 `<html data-theme>` 上的 CSS 变量实现，偏好存 localStorage；页面阅读色通过 `#stage.pc-*` 的 CSS 滤镜实现，不改动文件。

## 页面编辑

渲染进程用 `doc.getData()` 取得当前字节，通过 `pdf:ops` 交给主进程的 `pageops.js` 处理，再用结果字节替换窗格里的文档，并标记 `edited`；保存时把这些字节一并交给 `pdf:save`。删除 / 插入页面时未保存标注的页码会同步重映射；有未保存标注的页不能旋转。加密文档不能做页面编辑。

## IPC

| 通道 | 方向 | 作用 |
|---|---|---|
| `pdf:open` | 渲染 → 主 | 打开文件对话框（多选），返回 `[{path,data}|{path,error}]` |
| `pdf:save` | 渲染 → 主 | 写入标注并保存（可带编辑后的字节） |
| `pdf:ops` | 渲染 → 主 | 页面编辑，返回新字节 |
| `file:save` | 渲染 → 主 | 导出图片 / 提取页面时的「保存文件」对话框 |
| `recent:get/clear`、`settings:get/set` | 渲染 → 主 | 最近文件、设置 |
| `win:peek/center/fullscreen/hold` | 渲染 → 主 | 临时显示、居中、全屏、打印时保持可见 |
| `open-file` | 主 → 渲染 | 外部（双击 / 命令行）打开的文件数组 |
| `opacity:get/set`、`stealth:get/set` | 双向 | 透明度、隐身开关 |
| `trigger:get/preset/capture/cancel/presets` | 渲染 → 主 | 触发键设置 |
| `trigger-changed`、`open-trigger-dialog` 等 | 主 → 渲染 | 状态同步 |

## 安全边界

`contextIsolation: true`，渲染进程只能通过 `preload.js` 暴露的有限 API 访问主进程；`sandbox: false` 是 preload 需要使用 Node 模块所致。程序不含任何网络请求。键盘钩子的回调只比较编号，不存储按键内容。

## 测试

`npm test` 运行 `tests/*.test.js`：触发键逻辑（匹配、规范化、可录制性）与标注写入。Electron 与真实钩子行为需要在 Windows 上手动验证。

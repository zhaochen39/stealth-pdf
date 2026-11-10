# 更新日志 / Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- 标签内分屏：一个标签里左右并排两个 PDF，各自独立滚动 / 缩放 / 标注；可拖动分隔条、同步滚动、交换左右；`Ctrl+\` 分屏，`F6` 切换焦点窗格
- 可把另一个已打开的标签并入当前标签的右侧

### 变更
- 工具栏更紧凑，默认窗口宽度调整为 1280

## [1.0.0]

首个公开版本。

### 新增
- 触发显示：按住触发键且光标在窗口内才显示，其余情况隐藏；隐身开关
- 可自定义触发键（录制任意键 / 鼠标中键、后退、前进，或选常用项）；Fn 默认未绑定
- 多标签页：多选打开、拖拽打开、拖动排序、每标签独立缩放 / 滚动 / 标注、未保存提示
- 手型工具（H），任意工具下鼠标中键拖动平移
- 标注：高亮、画笔、文字（支持中文），颜色选择，撤销，保存写入 PDF
- 窗口透明度调节（滑块、托盘菜单、全局快捷键）
- 托盘菜单、全局快捷键 Ctrl+Alt+H / ↑ / ↓
- 全新图标与深色界面
- Windows 安装包（可选安装目录）与免安装 zip
- 日志文件（1 MB 轮转）、单元测试、CI 与 Release 工作流

[Unreleased]: https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/YOUR_GITHUB_USERNAME/stealth-pdf/releases/tag/v1.0.0

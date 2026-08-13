# HtyBox

> 把**多个终端**、**Claude Skill** 与 **Claude Memory** 整合到一个窗口的桌面工作台。
> 核心交互：把左栏 skill / 右栏 memory **拖拽**喂给终端里运行的 Claude Code / Codex / OpenCode，自动注入引用。

**技术栈**：Tauri 2 + Rust（`portable-pty`，Windows 旁加载新版 ConPTY）+ React 19 + TypeScript + Vite + xterm.js + Tailwind v4 + allotment（三栏）+ dockview（终端标签/分屏）。

## 功能

- **多终端工作台**：标签页 + 拖拽分屏，一个窗口里并排多个终端；PowerShell / Claude Code / Codex / OpenCode / Cursor / Kimi Profile 一键新建。
- **拖拽注入**：把 Skill / Memory / 文件拖进任意终端，按目标终端类型自动注入 `/skill`、`@路径` 等引用。
- **工作区 = 文件夹**：Cursor 式打开文件夹作为工作区；终端 cwd、Skill、Memory 均按工作区隔离；切换工作区后台终端常驻不杀。
- **文件工作台**：可展开文件树 + 内置编辑器（Markdown / SVG 预览）+ 双击 Shift 全局搜索 + 收藏 / 忽略 / 运行配置。
- **会话记录**：查看并一键恢复 Claude / Codex / OpenCode / Cursor / Kimi 的历史会话。
- **多 Agent 团队协作**：保存团队、一键开启一支由多个 Claude / Codex / OpenCode / Cursor / Kimi 组成的团队，经 MCP 中枢分工协作（任务派发 / 消息 / 共享黑板 / 文件归属 / 挂起唤醒 / 全自动接力 / 崩溃自动替补）。
- **Skill 上架/下架 + 模板**：按工作区只启用当前任务需要的一小撮 skill，降低 Claude 上下文压力。
- **界面字体切换**：鸿蒙 / 钉钉 / 阿里 / 文楷四款，本地子集化打包。
- **自动更新**：内置 updater，发布新版本自动提示升级。

## 安装

到 [Releases](https://github.com/htyashes-crypto/HtyBox/releases) 下载最新 Windows 安装包（`HtyBox_x.y.z_x64-setup.exe`）。

## 开发

在仓库根 `HtyBox/` 执行，包管理器为 **pnpm**：

| 命令 | 作用 |
|---|---|
| `pnpm install` | 装前端依赖 |
| `pnpm tauri dev` | **跑应用**（唯一入口） |
| `pnpm build` | 前端类型检查 + 打包 |
| `pnpm tauri build` | 出生产安装包 |

> Windows 下 `cargo` 务必在 **PowerShell** 跑（勿用 Git Bash，coreutils `link.exe` 会顶替 MSVC 链接器）。

## 设计文档

完整设计与实现计划在 [`Document/`](./Document/)（见 [文档索引](./Document/README.md)）：

| | |
|---|---|
| [01 产品与架构](./Document/01-产品与架构.md) | [02 后端 Rust](./Document/02-后端Rust设计.md) |
| [03 前端 React](./Document/03-前端React设计.md) | [04 数据模型与注入](./Document/04-数据模型与注入.md) |
| [05 里程碑 M0–M6](./Document/05-里程碑与任务拆解.md) | [06 风险/测试/打包](./Document/06-风险测试与打包.md) |
| [07 工作区管理](./Document/07-工作区管理.md) | [08 多 Agent 协作 M7](./Document/08-多Agent协作设计.md) |

## 状态

✅ **已发布**：M0–M9 全部实装 —— 多终端、拖拽注入、工作区、文件工作台、会话记录、多 Agent 协作、界面字体系统、打包发布流水线。当前版本见 [Releases](https://github.com/htyashes-crypto/HtyBox/releases)。

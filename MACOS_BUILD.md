# macOS Apple Silicon 本地构建

## 环境

- macOS Apple Silicon
- Xcode Command Line Tools
- Node.js 20+
- pnpm 9+
- Rust stable

项目通过 `src-tauri/src/platform_services/` 提供跨平台能力接口。终端、Agent 命令、文件定位、截图和剪贴板操作由目标平台实现，业务模块不直接调用 Windows 或 macOS API。

## 构建

在仓库根目录执行：

```bash
pnpm install
pnpm build:mac
```

产物位于：

```text
src-tauri/target/aarch64-apple-darwin/release/bundle/macos/HtyBox.app
src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/HtyBox_*.dmg
```

DMG 使用标准 Finder 安装布局。打开镜像后，将 `HtyBox.app` 拖到 `Applications` 图标即可覆盖安装。

这是未签名的内测包。首次打开时，在 Finder 中右键应用选择“打开”，或在系统设置的隐私与安全性中允许打开。

## 运行前提

Claude、Codex、Cursor 和 Kimi 的 CLI 需要单独安装，并且命令位于当前用户 PATH。HtyBox 会补充常见的 Homebrew、`~/.local/bin` 和 npm 全局目录，但不会替用户安装 Agent。

## 手动验证

- 默认终端可启动 zsh。
- Agent 终端可启动、输入、resize 和 Ctrl+C 正常。
- 工作区文件可打开，Finder 可定位文件。
- 截图快捷键可启动系统截图，并能把剪贴板图片保存到工作区。
- 应用退出后无残留 shell 或 Agent 进程。

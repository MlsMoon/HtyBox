// 内容预览窗口的渲染入口（第二窗口，独立 webview）。对照 main.tsx：
// 同样在渲染前先应用字体与主题（读同一份 localStorage，与主窗一致，避免开窗闪烁），
// 但**不引入** xterm / 终端侧任何模块——这个窗口只承载内容预览。
import ReactDOM from "react-dom/client";
import PreviewApp from "./components/PreviewApp";
import { initFont } from "./fonts";
import { initTheme } from "./theme";
import { IconProvider, DEFAULT_ICON_CONFIGS } from "@icon-park/react";
import "@icon-park/react/styles/index.css";
import "allotment/dist/style.css";
import "./index.css";

const ICON_CONFIG = {
  ...DEFAULT_ICON_CONFIGS,
  colors: {
    ...DEFAULT_ICON_CONFIGS.colors,
    outline: { fill: "currentColor", background: "transparent" },
  },
};

initFont();
initTheme();

// 窗口参数由 previewWindow.open 经 URL query 传入（工作区 id / 根路径 / 显示名）
const q = new URLSearchParams(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <IconProvider value={ICON_CONFIG}>
    <PreviewApp
      workspaceId={q.get("ws") ?? ""}
      workspacePath={q.get("path") ?? ""}
      workspaceName={q.get("name") ?? ""}
    />
  </IconProvider>,
);

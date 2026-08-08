import ReactDOM from "react-dom/client";
import App from "./App";
import { initFont } from "./fonts";
import { initTheme } from "./theme";
import { initPlatformServices } from "./platformServices";
import { IconProvider, DEFAULT_ICON_CONFIGS } from "@icon-park/react";
import "allotment/dist/style.css";
import "@icon-park/react/styles/index.css";
import "./index.css";

// IconPark 全局默认：沿用 outline 描边主题，并把描边色设为 currentColor，
// 让图标跟随父级文字色（与项目手写 SVG 的 currentColor 体系一致，调用处用 Tailwind text-* 控色即可）。
// 保持 prefix:'i' 默认不动，否则 spin 动画类名（.i-icon-spin）会对不上。
const ICON_CONFIG = {
  ...DEFAULT_ICON_CONFIGS,
  colors: {
    ...DEFAULT_ICON_CONFIGS.colors,
    outline: { fill: "currentColor", background: "transparent" },
  },
};

// 刻意不用 React.StrictMode —— 它在 dev 下二次挂载 effect 会重复 spawn/kill PTY 子进程。
// 启动时按持久化设置应用界面字体 + 主题（须在渲染前，避免闪烁）
initFont();
initTheme();

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <IconProvider value={ICON_CONFIG}>
      <App />
    </IconProvider>,
  );
};

void initPlatformServices().finally(renderApp);

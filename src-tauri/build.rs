#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::{env, fs};

fn main() {
    // 把随包的新版 ConPTY（conpty.dll + OpenConsole.exe，来自官方
    // Microsoft.Windows.Console.ConPTY 包）拷到 exe 同目录：portable-pty 会优先旁加载程序旁的
    // conpty.dll（见其 psuedocon.rs::load_conpty），该 conpty.dll 再拉起旁边的新版 OpenConsole.exe，
    // 取代 Win10 19045 系统自带的旧 in-box ConPTY —— 修复 claude/codex 输入框字符错位/吞字
    // （旧 ConPTY 增量刷新 VT 流的 bug；与 Windows Terminal 自带 OpenConsole 同款机制）。
    copy_conpty_next_to_exe();
    tauri_build::build()
}

/// 仅 Windows 需要旁加载 ConPTY；其它平台是 no-op。
#[cfg(windows)]
fn copy_conpty_next_to_exe() {
    // OUT_DIR = target/<profile>/build/<pkg-hash>/out → 上溯 3 级到 target/<profile>（= 最终 exe 目录，
    // 原生与交叉编译布局一致）。
    let out_dir = env::var("OUT_DIR").expect("cargo 未设置 OUT_DIR");
    let exe_dir = Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .expect("无法从 OUT_DIR 定位 target/<profile> 目录");

    // 仅 x64（当前唯一打包目标；arm64 待需要时另备）。
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("conpty")
        .join("x64");

    for name in ["conpty.dll", "OpenConsole.exe"] {
        let src = src_dir.join(name);
        let dst = exe_dir.join(name);
        // 缺二进制必须硬失败（不静默放过：否则会悄悄退回系统旧 ConPTY、bug 复现）。
        fs::copy(&src, &dst).unwrap_or_else(|e| {
            panic!("旁加载 ConPTY 失败：拷贝 {} → {} 出错：{e}", src.display(), dst.display())
        });
        // 源二进制变化时重跑本脚本（升级 ConPTY 版本即自动同步）。
        println!("cargo:rerun-if-changed={}", src.display());
    }
    println!(
        "cargo:warning=ConPTY 旁加载已就绪：conpty.dll + OpenConsole.exe 已拷至 {}",
        exe_dir.display()
    );
}

#[cfg(not(windows))]
fn copy_conpty_next_to_exe() {}

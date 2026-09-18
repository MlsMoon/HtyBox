//! Windows 输入状态查询与注入（拖拽卡死守卫用，见前端 dragStuckRecovery.ts）。

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VK_ESCAPE, VK_LBUTTON,
};

/// 鼠标主键是否物理按下（GetAsyncKeyState 高位 = 当前按下；系统级、与本进程是否有焦点无关）。
pub(super) fn primary_mouse_button_down() -> bool {
    (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0
}

/// 注入一次 Esc（按下 + 抬起）。用于取消已经卡住的系统拖拽会话——注入 Esc 而非鼠标抬起，
/// 后者会在光标处产生一次真实 drop（可能误移动文件），Esc 是纯取消语义。
pub(super) fn send_escape_key() -> bool {
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_ESCAPE,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [key(Default::default()), key(KEYEVENTF_KEYUP)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

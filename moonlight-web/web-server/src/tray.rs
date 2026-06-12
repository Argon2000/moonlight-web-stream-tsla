//! Windows system tray integration.
//!
//! Provides a tray icon with context menu for:
//! - Show/Hide console window
//! - Toggle "Start with Windows" (registry-based)
//! - Toggle "Start minimized" (registry-based)
//! - Exit the application

use log::info;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tray_icon::{
    TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, CheckMenuItem},
    Icon,
};
use windows::Win32::System::Console::GetConsoleWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    ShowWindow, SW_HIDE, SW_SHOW, IsWindowVisible,
    GetMessageW, TranslateMessage, DispatchMessageW, MSG,
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, SetForegroundWindow,
};

static CONSOLE_VISIBLE: AtomicBool = AtomicBool::new(true);

const APP_NAME: &str = "Moonlight Web Tesla";
const REGISTRY_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const REGISTRY_VALUE: &str = "MoonlightWebTesla";
const REGISTRY_APP_KEY: &str = r"Software\MoonlightWebTesla";

/// Check if "Start with Windows" is currently enabled in the registry.
fn is_autostart_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey(REGISTRY_KEY) {
        key.get_value::<String, _>(REGISTRY_VALUE).is_ok()
    } else {
        false
    }
}

/// Enable or disable "Start with Windows" via registry.
/// The command includes the exe path with its directory as working dir.
fn set_autostart(enabled: bool) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if enabled {
        if let Ok(key) = hkcu.open_subkey_with_flags(REGISTRY_KEY, KEY_WRITE) {
            let exe_path = std::env::current_exe()
                .map(|p| format!("\"{}\" --minimized", p.display()))
                .unwrap_or_default();
            let _ = key.set_value(REGISTRY_VALUE, &exe_path);
            info!("[Tray] Enabled Start with Windows: {}", exe_path);
        }
    } else if let Ok(key) = hkcu.open_subkey_with_flags(REGISTRY_KEY, KEY_WRITE) {
        let _ = key.delete_value(REGISTRY_VALUE);
        info!("[Tray] Disabled Start with Windows");
    }
}

/// Check if "Start minimized" is enabled (stored in app registry key).
pub fn is_start_minimized() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey(REGISTRY_APP_KEY) {
        key.get_value::<u32, _>("StartMinimized").unwrap_or(0) == 1
    } else {
        false
    }
}

fn set_start_minimized(enabled: bool) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .create_subkey_with_flags(REGISTRY_APP_KEY, KEY_WRITE)
        .map(|(k, _)| k);
    if let Ok(key) = key {
        let _ = key.set_value("StartMinimized", &(if enabled { 1u32 } else { 0u32 }));
        info!("[Tray] Start minimized: {}", enabled);
    }
}

/// Hide the console window (called from main on start-minimized).
pub fn hide_console() {
    unsafe {
        let hwnd = GetConsoleWindow();
        if hwnd.is_invalid() {
            return;
        }
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_style = (ex_style & !(WS_EX_APPWINDOW.0 as isize)) | (WS_EX_TOOLWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
        let _ = ShowWindow(hwnd, SW_HIDE);
        CONSOLE_VISIBLE.store(false, Ordering::Relaxed);
    }
}

fn show_console() {
    unsafe {
        let hwnd = GetConsoleWindow();
        if hwnd.is_invalid() {
            return;
        }
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_style = (ex_style | (WS_EX_APPWINDOW.0 as isize)) & !(WS_EX_TOOLWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        CONSOLE_VISIBLE.store(true, Ordering::Relaxed);
    }
}

fn toggle_console() {
    if CONSOLE_VISIBLE.load(Ordering::Relaxed) {
        hide_console();
    } else {
        show_console();
    }
}

fn create_icon() -> Icon {
    // 32x32 RGBA icon - simple moonlight circle (dark ring, white center, dark cross)
    let size: u32 = 32;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let cx = size as f32 / 2.0;
    let cy = size as f32 / 2.0;
    let r_outer = cx - 0.5;
    let r_inner = r_outer * 0.75;

    for y in 0..size {
        for x in 0..size {
            let idx = ((y * size + x) * 4) as usize;
            let dx = x as f32 - cx + 0.5;
            let dy = y as f32 - cy + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist > r_outer {
                // transparent
            } else if dist > r_inner {
                // dark ring
                rgba[idx] = 86;
                rgba[idx + 1] = 92;
                rgba[idx + 2] = 100;
                rgba[idx + 3] = 255;
            } else {
                // Check cross pattern
                let bar = size as f32 * 0.06;
                let on_cross = dy.abs() <= bar
                    || dx.abs() <= bar
                    || (dx - dy).abs() <= bar * 1.4
                    || (dx + dy).abs() <= bar * 1.4;
                if on_cross {
                    rgba[idx] = 86;
                    rgba[idx + 1] = 92;
                    rgba[idx + 2] = 100;
                    rgba[idx + 3] = 255;
                } else {
                    rgba[idx] = 255;
                    rgba[idx + 1] = 255;
                    rgba[idx + 2] = 255;
                    rgba[idx + 3] = 255;
                }
            }
        }
    }

    Icon::from_rgba(rgba, size, size).expect("failed to create tray icon")
}

/// Spawn the system tray on a dedicated thread.
/// Returns a shutdown signal that, when set to true, will cause the tray thread to exit.
pub fn spawn_tray(exit_signal: Arc<AtomicBool>) {
    // Check initial console visibility
    unsafe {
        let hwnd = GetConsoleWindow();
        if !hwnd.is_invalid() {
            let visible = IsWindowVisible(hwnd).as_bool();
            CONSOLE_VISIBLE.store(visible, Ordering::Relaxed);
        }
    }

    std::thread::spawn(move || {
        run_tray_loop(exit_signal);
    });
}

fn run_tray_loop(exit_signal: Arc<AtomicBool>) {
    let icon = create_icon();

    let show_hide_label = if CONSOLE_VISIBLE.load(Ordering::Relaxed) { "Hide Console" } else { "Show Console" };
    let show_hide = MenuItem::new(show_hide_label, true, None);
    let autostart = CheckMenuItem::new("Start with Windows", true, is_autostart_enabled(), None);
    let start_min = CheckMenuItem::new("Start minimized", true, is_start_minimized(), None);
    let separator = PredefinedMenuItem::separator();
    let quit = MenuItem::new("Exit", true, None);

    let menu = Menu::new();
    let _ = menu.append(&show_hide);
    let _ = menu.append(&autostart);
    let _ = menu.append(&start_min);
    let _ = menu.append(&separator);
    let _ = menu.append(&quit);

    let _tray = TrayIconBuilder::new()
        .with_tooltip(APP_NAME)
        .with_icon(icon)
        .with_menu(Box::new(menu))
        .build()
        .expect("failed to build tray icon");

    let show_hide_id = show_hide.id().clone();
    let autostart_id = autostart.id().clone();
    let start_min_id = start_min.id().clone();
    let quit_id = quit.id().clone();

    // Event loop — tray-icon requires a Win32 message pump to display the context menu
    // and deliver click events. We use GetMessageW which blocks until a message arrives,
    // and check for menu events after each message is dispatched.
    let menu_rx = MenuEvent::receiver();

    loop {
        // Pump Win32 messages (blocking — wakes on any window message including tray clicks)
        unsafe {
            let mut msg = MSG::default();
            let ret = GetMessageW(&mut msg, None, 0, 0);
            if ret.0 <= 0 {
                break; // WM_QUIT or error
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // Process all pending menu events after dispatching
        while let Ok(event) = menu_rx.try_recv() {
            if event.id() == &show_hide_id {
                toggle_console();
                let label = if CONSOLE_VISIBLE.load(Ordering::Relaxed) {
                    "Hide Console"
                } else {
                    "Show Console"
                };
                show_hide.set_text(label);
            } else if event.id() == &autostart_id {
                let new_state = !is_autostart_enabled();
                set_autostart(new_state);
                autostart.set_checked(new_state);
            } else if event.id() == &start_min_id {
                let new_state = !is_start_minimized();
                set_start_minimized(new_state);
                start_min.set_checked(new_state);
            } else if event.id() == &quit_id {
                exit_signal.store(true, Ordering::Relaxed);
                std::process::exit(0);
            }
        }

        if exit_signal.load(Ordering::Relaxed) {
            break;
        }
    }
}

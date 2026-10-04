mod claude;
mod commands;
mod engine;
mod websession;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent,
    menu::{CheckMenuItem, MenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt as _;

struct TrayAnchor {
    monitor_x: f64,
    monitor_y: f64,
    #[cfg(target_os = "macos")]
    x: f64,
    #[cfg(target_os = "macos")]
    y: f64,
    #[cfg(target_os = "macos")]
    width: f64,
    #[cfg(target_os = "macos")]
    height: f64,
}

pub struct AppState {
    height: Mutex<f64>,
    width: Mutex<f64>,
    anchor: Mutex<Option<TrayAnchor>>,
    hidden_at: Mutex<Option<Instant>>,
    // Set once the popup gains focus after a show. Windows can refuse focus to a
    // background process, and hiding on a blur that follows no focus would close
    // the popup the moment it opens.
    focused: AtomicBool,
    // The webview's CSS pixel ratio over the monitor scale. Windows text scaling
    // enlarges CSS pixels without changing the monitor scale, so sizes in CSS
    // pixels need this extra factor to become physical pixels.
    zoom: Mutex<f64>,
    // A pinned popup stays up when it loses focus and opens where it was last dragged.
    pinned: AtomicBool,
    // Top-left corner of the pinned popup in physical pixels.
    pin_pos: Mutex<Option<(i32, i32)>>,
    // The last corner Augur placed the popup at, so its own moves are not saved as a drag.
    placed_at: Mutex<Option<(i32, i32)>>,
    // Bumped on each drag; a save runs only when no later drag has bumped it.
    pin_save: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            height: Mutex::new(560.0),
            width: Mutex::new(400.0),
            anchor: Mutex::new(None),
            hidden_at: Mutex::new(None),
            focused: AtomicBool::new(false),
            zoom: Mutex::new(1.0),
            pinned: AtomicBool::new(false),
            pin_pos: Mutex::new(None),
            placed_at: Mutex::new(None),
            pin_save: AtomicU64::new(0),
        }
    }
}

#[cfg(windows)]
fn taskbar_anchor() -> Option<(f64, f64)> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};
    let name: Vec<u16> = "Shell_TrayWnd".encode_utf16().chain(Some(0)).collect();
    let hwnd = unsafe { FindWindowW(name.as_ptr(), std::ptr::null()) };
    if hwnd.is_null() {
        return None;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return None;
    }
    Some((
        (rect.left + rect.right) as f64 / 2.0,
        (rect.top + rect.bottom) as f64 / 2.0,
    ))
}

#[cfg(not(windows))]
fn taskbar_anchor() -> Option<(f64, f64)> {
    None
}

#[cfg(windows)]
pub fn platform_tray_icon_size() -> u32 {
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, SM_CXSMICON};
    let name: Vec<u16> = "Shell_TrayWnd".encode_utf16().chain(Some(0)).collect();
    let hwnd = unsafe { FindWindowW(name.as_ptr(), std::ptr::null()) };
    let dpi = if hwnd.is_null() {
        96
    } else {
        unsafe { GetDpiForWindow(hwnd) }.max(96)
    };
    unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) }.max(16) as u32
}

#[cfg(target_os = "macos")]
pub fn platform_tray_icon_size() -> u32 {
    22
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn platform_tray_icon_size() -> u32 {
    24
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PinFile {
    pinned: bool,
    x: Option<i32>,
    y: Option<i32>,
}

fn pin_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("popup.json"))
}

/// Reads the pin and its spot from the last run.
fn load_pin(app: &tauri::AppHandle) {
    let Some(file) = pin_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<PinFile>(&text).ok())
    else {
        return;
    };
    let state = app.state::<AppState>();
    state.pinned.store(file.pinned, Ordering::SeqCst);
    if let (Some(x), Some(y), Ok(mut pos)) = (file.x, file.y, state.pin_pos.lock()) {
        *pos = Some((x, y));
    }
}

pub(crate) fn save_pin(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let pos = *state.pin_pos.lock().map_err(|e| e.to_string())?;
    let file = PinFile {
        pinned: state.pinned.load(Ordering::SeqCst),
        x: pos.map(|p| p.0),
        y: pos.map(|p| p.1),
    };
    let path = pin_path(app).ok_or("Config folder unavailable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(&file).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// Saves the dragged spot once the drag has been still for half a second.
fn save_pin_soon(app: &tauri::AppHandle) {
    let ticket = app
        .state::<AppState>()
        .pin_save
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if app.state::<AppState>().pin_save.load(Ordering::SeqCst) == ticket {
            let _ = save_pin(&app);
        }
    });
}

/// The pinned spot and the monitor it is on. None when not pinned, or when that monitor is gone.
fn pinned_spot(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<(tauri::Monitor, (i32, i32))> {
    let state = app.state::<AppState>();
    if !state.pinned.load(Ordering::SeqCst) {
        return None;
    }
    let (x, y) = (*state.pin_pos.lock().ok()?)?;
    let monitor = window
        .monitor_from_point(x as f64 + 8.0, y as f64 + 8.0)
        .ok()
        .flatten()?;
    let at = monitor.position();
    let size = monitor.size();
    let inside = x + 8 >= at.x
        && y + 8 >= at.y
        && x + 8 < at.x + size.width as i32
        && y + 8 < at.y + size.height as i32;
    inside.then_some((monitor, (x, y)))
}

/// Keeps a window of the given size inside the work area, moving it no more than it must.
fn clamp_into(
    (x, y): (i32, i32),
    (width, height): (u32, u32),
    work_at: (i32, i32),
    work_size: (u32, u32),
) -> (i32, i32) {
    let right = work_at.0 + work_size.0 as i32 - width as i32;
    let bottom = work_at.1 + work_size.1 as i32 - height as i32;
    (x.min(right).max(work_at.0), y.min(bottom).max(work_at.1))
}

/// The monitor the popup opens on: the pinned spot's, else where the tray was last clicked, else the taskbar's monitor.
fn popup_monitor(app: &tauri::AppHandle) -> Result<tauri::Monitor, String> {
    let window = app.get_webview_window("popup").ok_or("Popup unavailable")?;
    if let Some((monitor, _)) = pinned_spot(app, &window) {
        return Ok(monitor);
    }
    let state = app.state::<AppState>();
    let anchor = state.anchor.lock().map_err(|e| e.to_string())?;
    let point = anchor
        .as_ref()
        .map(|anchor| (anchor.monitor_x, anchor.monitor_y))
        .or_else(taskbar_anchor);
    point
        .and_then(|(x, y)| window.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "Monitor unavailable".to_string())
}

/// Usable height in logical pixels on the popup's monitor, minus the top and bottom gaps.
pub fn max_popup_css_height(app: &tauri::AppHandle) -> Result<f64, String> {
    let monitor = popup_monitor(app)?;
    let zoom = *app
        .state::<AppState>()
        .zoom
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(monitor.work_area().size.height as f64 / (monitor.scale_factor() * zoom) - 20.0)
}

/// Records the text zoom from the page's devicePixelRatio and the window's own scale.
pub fn set_text_zoom(app: &tauri::AppHandle, dpr: Option<f64>) -> Result<(), String> {
    let Some(dpr) = dpr.filter(|d| d.is_finite() && *d > 0.0) else {
        return Ok(());
    };
    let window = app.get_webview_window("popup").ok_or("Popup unavailable")?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    *app.state::<AppState>()
        .zoom
        .lock()
        .map_err(|e| e.to_string())? = (dpr / scale).clamp(0.5, 4.0);
    Ok(())
}

pub fn anchor_popup(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("popup").ok_or("Popup unavailable")?;
    let state = app.state::<AppState>();
    let monitor = popup_monitor(app)?;
    // Only macOS places the popup relative to the tray rect; Windows anchors to the work area.
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    let anchor = state.anchor.lock().map_err(|e| e.to_string())?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let gap = (10.0 * scale).round() as i32;
    let zoom = *state.zoom.lock().map_err(|e| e.to_string())?;
    let css_scale = scale * zoom;
    let css_width = *state.width.lock().map_err(|e| e.to_string())?;
    let width = ((css_width * css_scale).round() as u32)
        .min(work.size.width.saturating_sub(2 * gap as u32));
    let max_height = (work.size.height as i32 - 2 * gap).max(120) as u32;
    let css_height = *state.height.lock().map_err(|e| e.to_string())?;
    let height = ((css_height * css_scale).round() as u32).clamp(120, max_height);
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    let mut outer = window.outer_size().map_err(|e| e.to_string())?;
    let available_height = (work.size.height as i32 - 2 * gap).max(120) as u32;
    if outer.height > available_height {
        let extra = outer.height.saturating_sub(height);
        window
            .set_size(PhysicalSize::new(
                width,
                available_height.saturating_sub(extra).max(120),
            ))
            .map_err(|e| e.to_string())?;
        outer = window.outer_size().map_err(|e| e.to_string())?;
    }
    if let Some((_, spot)) = pinned_spot(app, &window) {
        // A pinned popup keeps its top edge when its height changes, and moves only to stay on screen.
        let (x, y) = clamp_into(
            spot,
            (outer.width, outer.height),
            (work.position.x, work.position.y),
            (work.size.width, work.size.height),
        );
        *state.placed_at.lock().map_err(|e| e.to_string())? = Some((x, y));
        return window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string());
    }
    let right = work.position.x + work.size.width as i32;
    let bottom = work.position.y + work.size.height as i32;
    #[cfg(target_os = "macos")]
    let (x, y) = if let Some(tray) = anchor.as_ref() {
        let x = (tray.x + tray.width / 2.0 - outer.width as f64 / 2.0).round() as i32;
        let y = (tray.y + tray.height).round() as i32 + gap;
        (
            x.clamp(
                work.position.x + gap,
                (right - outer.width as i32 - gap).max(work.position.x + gap),
            ),
            y.clamp(
                work.position.y + gap,
                (bottom - outer.height as i32 - gap).max(work.position.y + gap),
            ),
        )
    } else {
        (right - outer.width as i32 - gap, work.position.y + gap)
    };
    #[cfg(not(target_os = "macos"))]
    let (x, y) = (
        right - outer.width as i32 - gap,
        bottom - outer.height as i32 - gap,
    );
    *state.placed_at.lock().map_err(|e| e.to_string())? = Some((x, y));
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn show_popup(app: &tauri::AppHandle) -> Result<(), String> {
    anchor_popup(app)?;
    let window = app.get_webview_window("popup").ok_or("Popup unavailable")?;
    app.state::<AppState>()
        .focused
        .store(false, Ordering::SeqCst);
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    window.emit("popup-shown", ()).map_err(|e| e.to_string())
}

fn toggle_popup(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("popup") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        if let Ok(mut hidden) = app.state::<AppState>().hidden_at.lock() {
            *hidden = Some(Instant::now());
        }
        return;
    }
    if app
        .state::<AppState>()
        .hidden_at
        .lock()
        .ok()
        .and_then(|time| *time)
        .is_some_and(|time| time.elapsed() < Duration::from_millis(350))
    {
        return;
    }
    let _ = show_popup(app);
}

/// Registers the shortcut that opens and closes the panel from anywhere, replacing any earlier one.
/// None or an empty string turns it off.
#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, accelerator: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().map_err(|e| e.to_string())?;
    let Some(accelerator) = accelerator.filter(|a| !a.trim().is_empty()) else {
        return Ok(());
    };
    shortcuts
        .on_shortcut(accelerator.trim(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_popup(app);
            }
        })
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(websession::WebSessions::default())
        .manage(engine::EngineBridge::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_popup(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_hotkey,
            commands::http_request,
            commands::web_push,
            claude::claude_status,
            claude::claude_code_install,
            claude::claude_code_remove,
            claude::claude_desktop_install,
            claude::claude_desktop_remove,
            commands::read_home_file,
            commands::write_home_file_atomic,
            commands::run_command,
            commands::dispatch_cli,
            engine::engine_start,
            engine::engine_send,
            commands::copilot_usage,
            commands::keychain_get,
            commands::keychain_set,
            commands::secret_get,
            commands::secret_set,
            commands::secret_delete,
            commands::secret_has,
            commands::load_json,
            commands::save_json,
            commands::load_history,
            commands::save_history,
            commands::set_tray,
            commands::tray_icon_size,
            commands::set_popup_height,
            commands::set_popup_size,
            commands::max_popup_height,
            commands::hide_popup,
            commands::show_popup,
            commands::popup_pinned,
            commands::set_popup_pinned,
            commands::start_popup_drag,
            websession::web_session_sign_in,
            websession::web_session_read
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            load_pin(app.handle());
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start at login",
                true,
                app.autolaunch().is_enabled().unwrap_or(false),
                None::<&str>,
            )?;
            let menu = MenuBuilder::new(app)
                .text("open", "Open usage")
                .text("refresh", "Refresh now")
                .text("settings", "Open settings")
                .separator()
                .item(&autostart_item)
                .separator()
                .text("quit", "Quit Augur")
                .build()?;
            TrayIconBuilder::with_id("main")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("Default icon unavailable")?,
                )
                .tooltip("Augur")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        let _ = show_popup(app);
                    }
                    "refresh" => {
                        if let Some(window) = app.get_webview_window("popup") {
                            let _ = window.emit("refresh-requested", ());
                        }
                    }
                    "settings" => {
                        let _ = show_popup(app);
                        if let Some(window) = app.get_webview_window("popup") {
                            let _ = window.emit("settings-requested", ());
                        }
                    }
                    "autostart" => {
                        if let Ok(enabled) = app.autolaunch().is_enabled() {
                            let result = if enabled {
                                app.autolaunch().disable()
                            } else {
                                app.autolaunch().enable()
                            };
                            let _ = autostart_item.set_checked(result.is_ok() != enabled);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        position,
                        rect,
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        #[cfg(target_os = "macos")]
                        let tray_position: PhysicalPosition<i32> = rect.position.to_physical(1.0);
                        #[cfg(target_os = "macos")]
                        let size: PhysicalSize<u32> = rect.size.to_physical(1.0);
                        #[cfg(not(target_os = "macos"))]
                        let _ = rect;
                        if let Ok(mut anchor) = app.state::<AppState>().anchor.lock() {
                            *anchor = Some(TrayAnchor {
                                monitor_x: position.x,
                                monitor_y: position.y,
                                #[cfg(target_os = "macos")]
                                x: tray_position.x as f64,
                                #[cfg(target_os = "macos")]
                                y: tray_position.y as f64,
                                #[cfg(target_os = "macos")]
                                width: size.width as f64,
                                #[cfg(target_os = "macos")]
                                height: size.height as f64,
                            });
                        }
                        toggle_popup(app);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "popup" {
                return;
            }
            match event {
                WindowEvent::Focused(true) => {
                    window
                        .state::<AppState>()
                        .focused
                        .store(true, Ordering::SeqCst);
                }
                WindowEvent::Focused(false) => {
                    if !window
                        .state::<AppState>()
                        .focused
                        .swap(false, Ordering::SeqCst)
                    {
                        return;
                    }
                    if window.state::<AppState>().pinned.load(Ordering::SeqCst) {
                        return;
                    }
                    let _ = window.hide();
                    if let Ok(mut hidden) = window.state::<AppState>().hidden_at.lock() {
                        *hidden = Some(Instant::now());
                    }
                }
                WindowEvent::Moved(position) => {
                    let state = window.state::<AppState>();
                    if !state.pinned.load(Ordering::SeqCst) {
                        return;
                    }
                    let spot = (position.x, position.y);
                    if state.placed_at.lock().ok().and_then(|at| *at) == Some(spot) {
                        return;
                    }
                    if let Ok(mut pos) = state.pin_pos.lock() {
                        *pos = Some(spot);
                    }
                    save_pin_soon(window.app_handle());
                }
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("Augur failed to start");
}

#[cfg(test)]
mod tests {
    use super::clamp_into;

    #[test]
    fn a_spot_on_screen_stays_put() {
        assert_eq!(
            clamp_into((100, 50), (400, 560), (0, 0), (1920, 1040)),
            (100, 50)
        );
    }

    #[test]
    fn a_taller_popup_moves_up_only_as_far_as_it_must() {
        assert_eq!(
            clamp_into((100, 700), (400, 560), (0, 0), (1920, 1040)),
            (100, 480)
        );
    }

    #[test]
    fn a_spot_past_the_left_or_top_edge_comes_back_inside() {
        assert_eq!(
            clamp_into((-50, -20), (400, 560), (0, 0), (1920, 1040)),
            (0, 0)
        );
    }

    #[test]
    fn a_second_monitor_keeps_its_own_offset() {
        assert_eq!(
            clamp_into((3700, 10), (400, 560), (1920, 0), (1920, 1040)),
            (3440, 10)
        );
    }
}

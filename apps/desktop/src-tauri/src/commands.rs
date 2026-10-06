use std::{
    path::{Component, Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::{Manager, image::Image};

use crate::{AppState, anchor_popup};

#[derive(Serialize)]
pub struct CommandOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .ok_or_else(|| "Home directory unavailable".into())
}

pub(crate) fn relative_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\\') || path.contains(':') || path.starts_with('/') {
        return Err("Invalid home-relative path".into());
    }
    let parsed = Path::new(path);
    if !parsed
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("Invalid home-relative path".into());
    }
    Ok(parsed.to_path_buf())
}

/// The routes file for the dispatch service: `dispatch/routes.json` in the folder that holds the export file.
fn dispatch_routes_path(export: &Path) -> PathBuf {
    export.with_file_name("dispatch").join("routes.json")
}

async fn allowed_home_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let relative = relative_path(path)?;
    let config_file = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("config.json");
    let config = match tokio::fs::read_to_string(config_file).await {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    // Only the dispatch routes file, in the dispatch subfolder of the folder that holds the export file named in settings (a .json file).
    let export_file = config
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.get("exportPath")?.as_str().map(str::to_owned))
        .and_then(|export| relative_path(&export).ok())
        .filter(|export| export.extension().is_some_and(|ext| ext == "json"));
    if export_file.as_deref().map(dispatch_routes_path).as_deref() != Some(relative.as_path()) {
        return Err("Home file path is not allowed".into());
    }
    let home = home_dir()?;
    let full = home.join(relative);
    let parent = full.parent().ok_or("Invalid home-relative path")?;
    let real_home = home.canonicalize().map_err(|e| e.to_string())?;
    let mut existing = parent;
    while !existing.exists() {
        existing = existing.parent().ok_or("Invalid home-relative path")?;
    }
    if !existing
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&real_home)
    {
        return Err("Home file path escapes the home directory".into());
    }
    if full.exists()
        && !full
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&real_home)
    {
        return Err("Home file path escapes the home directory".into());
    }
    Ok(full)
}

async fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid path")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".augur-{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temporary, text)
        .await
        .map_err(|e| e.to_string())?;
    let result = replace_file(&temporary, path);
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    if to.exists() {
        let from_wide = wide(from);
        let to_wide = wide(to);
        let ok = unsafe {
            ReplaceFileW(
                to_wide.as_ptr(),
                from_wide.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    } else {
        std::fs::rename(from, to).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn read_home_file(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    let path = allowed_home_path(&app, &path).await?;
    match tokio::fs::read_to_string(path).await {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn write_home_file_atomic(
    app: tauri::AppHandle,
    path: String,
    text: String,
) -> Result<(), String> {
    let path = allowed_home_path(&app, &path).await?;
    atomic_write(&path, &text).await
}

fn dispatch_setting_allowed(key: &str, value: &str) -> bool {
    let plain = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b',' | b'_' | b'-' | b'.'));
    if !plain {
        return false;
    }
    match key {
        "retentionDays" | "persistPrompts" | "maxConcurrent" | "maxDepth" | "maxDescendants"
        | "decision.backend" | "decision.shadow" | "learn.recordTasks" => true,
        "adapters" => value.split(',').all(|a| a != "exec"),
        _ => false,
    }
}

/// What the page may ask the packaged `augur` command to do: read the service's state (including the balance report) and start or stop it, cancel a job, never submit or apply one.
fn dispatch_args_allowed(args: &[String]) -> bool {
    let is_id = |s: &str| s.len() == 12 && s.bytes().all(|b| b.is_ascii_hexdigit());
    let is_number =
        |s: &str| !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit());
    let is_state = |s: &str| {
        !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    };
    let mut rest = args.iter().map(String::as_str);
    match rest.next() {
        Some("service") => {
            let rest: Vec<&str> = rest.filter(|a| *a != "--json").collect();
            matches!(
                rest.as_slice(),
                ["status" | "start" | "stop"] | ["stop", "--if-idle"]
            )
        }
        Some("routes" | "pressure" | "balance") => rest.all(|a| a == "--json"),
        Some("usage") => {
            let rest: Vec<&str> = rest.collect();
            match rest.as_slice() {
                ["--json"] => true,
                ["--json", "--limit", n] => is_number(n),
                _ => false,
            }
        }
        Some("config") => {
            let rest: Vec<&str> = rest.collect();
            match rest.as_slice() {
                [] | ["--json"] => true,
                ["set", key, value] => dispatch_setting_allowed(key, value),
                _ => false,
            }
        }
        Some("jobs") => {
            let rest: Vec<&str> = rest.collect();
            let mut i = 0;
            while i < rest.len() {
                match rest[i] {
                    "--json" => i += 1,
                    "--state" if rest.get(i + 1).is_some_and(|v| is_state(v)) => i += 2,
                    "--limit" if rest.get(i + 1).is_some_and(|v| is_number(v)) => i += 2,
                    _ => return false,
                }
            }
            true
        }
        Some("test") => {
            let route_ok = |s: &str| {
                s.len() <= 40
                    && s.starts_with(|c: char| c.is_ascii_lowercase())
                    && s.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'
                    })
            };
            rest.next().is_some_and(route_ok) && rest.all(|a| a == "--json")
        }
        Some("status" | "result" | "cancel") => {
            rest.next().is_some_and(is_id) && rest.all(|a| a == "--json")
        }
        Some("logs") => {
            rest.next().is_some_and(is_id) && rest.all(|a| a == "--json" || a == "--stderr")
        }
        _ => false,
    }
}

/// The folder holding the packaged service, its runtime and the `augur` command. AUGUR_SERVICE_DIR points a dev build at a local one.
pub(crate) fn service_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    std::env::var_os("AUGUR_SERVICE_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().resource_dir().ok().map(|d| d.join("service")))
        .filter(|d| d.join("augur.mjs").is_file())
        .ok_or_else(|| "The dispatch service is not installed with this build".to_owned())
}

pub(crate) const SERVICE_NODE: &str = if cfg!(windows) {
    "augur-node.exe"
} else {
    "augur-node"
};

#[tauri::command]
pub async fn dispatch_cli(
    app: tauri::AppHandle,
    args: Vec<String>,
) -> Result<CommandOutput, String> {
    if !dispatch_args_allowed(&args) {
        return Err("Command and arguments are not allowed".into());
    }
    let dir = service_dir(&app)?;
    let mut process = tokio::process::Command::new(dir.join(SERVICE_NODE));
    process
        .arg(dir.join("augur.mjs"))
        .args(args)
        .current_dir(&dir)
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        process.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(Duration::from_secs(20), process.output())
        .await
        .map_err(|_| "Command timed out".to_owned())?
        .map_err(|e| e.to_string())?;
    Ok(CommandOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[tauri::command]
pub fn set_tray(
    app: tauri::AppHandle,
    png_base64: Option<String>,
    tooltip: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    let tray = app.tray_by_id("main").ok_or("Tray unavailable")?;
    if let Some(png) = png_base64 {
        let bytes = STANDARD.decode(png).map_err(|e| e.to_string())?;
        let image = Image::from_bytes(&bytes).map_err(|e| e.to_string())?;
        tray.set_icon(Some(image)).map_err(|e| e.to_string())?;
    }
    if let Some(tooltip) = tooltip {
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    if let Some(title) = title {
        tray.set_title(Some(title)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = title;
    Ok(())
}

#[tauri::command]
pub fn tray_icon_size() -> u32 {
    crate::platform_tray_icon_size()
}

#[tauri::command]
pub fn set_popup_height(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    css_px: f64,
) -> Result<(), String> {
    if !css_px.is_finite() {
        return Err("Invalid popup height".into());
    }
    *state.height.lock().map_err(|e| e.to_string())? = css_px.max(120.0);
    anchor_popup(&app)
}

#[tauri::command]
pub fn set_popup_size(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    css_width: f64,
    css_height: f64,
    dpr: Option<f64>,
) -> Result<(), String> {
    if !css_width.is_finite() || !css_height.is_finite() {
        return Err("Invalid popup size".into());
    }
    crate::set_text_zoom(&app, dpr)?;
    *state.width.lock().map_err(|e| e.to_string())? = css_width.clamp(320.0, 1200.0);
    *state.height.lock().map_err(|e| e.to_string())? = css_height.max(120.0);
    anchor_popup(&app)
}

#[tauri::command]
pub fn max_popup_height(app: tauri::AppHandle, dpr: Option<f64>) -> Result<f64, String> {
    crate::set_text_zoom(&app, dpr)?;
    crate::max_popup_css_height(&app)
}

#[tauri::command]
pub fn hide_popup(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("popup")
        .ok_or("Popup unavailable")?
        .hide()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_popup(app: tauri::AppHandle) -> Result<(), String> {
    crate::show_popup(&app)
}

#[tauri::command]
pub fn popup_pinned(state: tauri::State<'_, AppState>) -> bool {
    state.pinned.load(Ordering::SeqCst)
}

/// Pins the popup where it is now, or unpins it so a click elsewhere hides it again.
#[tauri::command]
pub fn set_popup_pinned(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    pinned: bool,
) -> Result<(), String> {
    let window = app.get_webview_window("popup").ok_or("Popup unavailable")?;
    let spot = if pinned {
        let at = window.outer_position().map_err(|e| e.to_string())?;
        Some((at.x, at.y))
    } else {
        None
    };
    *state.pin_pos.lock().map_err(|e| e.to_string())? = spot;
    if spot.is_some() {
        *state.placed_at.lock().map_err(|e| e.to_string())? = spot;
    }
    state.pinned.store(pinned, Ordering::SeqCst);
    crate::save_pin(&app)
}

/// Starts moving the pinned popup with the mouse. Does nothing while it is not pinned.
#[tauri::command]
pub fn start_popup_drag(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if !state.pinned.load(Ordering::SeqCst) {
        return Ok(());
    }
    app.get_webview_window("popup")
        .ok_or("Popup unavailable")?
        .start_dragging()
        .map_err(|e| e.to_string())
}

/// Names the package manager that owns this install, from a marker file its package puts beside the app. Only the Arch package writes one.
pub(crate) fn package_manager_marker(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let name = text.trim();
    (!name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_alphanumeric())).then(|| name.to_string())
}

#[tauri::command]
pub fn package_manager() -> Option<String> {
    if cfg!(target_os = "linux") {
        package_manager_marker(Path::new("/usr/lib/Augur/package-manager"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{dispatch_args_allowed, dispatch_routes_path, package_manager_marker};
    use std::path::Path;

    #[test]
    fn a_package_marker_names_its_manager_and_nothing_else_counts() {
        let dir = std::env::temp_dir().join(format!("augur-marker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("package-manager");
        std::fs::write(&file, "pacman\n").unwrap();
        assert_eq!(package_manager_marker(&file).as_deref(), Some("pacman"));
        std::fs::write(&file, "  \n").unwrap();
        assert_eq!(package_manager_marker(&file), None);
        std::fs::write(&file, "not a name; rm -rf").unwrap();
        assert_eq!(package_manager_marker(&file), None);
        assert_eq!(package_manager_marker(&dir.join("missing")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dispatch_routes_file_sits_in_the_export_folder() {
        assert_eq!(
            dispatch_routes_path(Path::new(".augur/usage.json")),
            Path::new(".augur/dispatch/routes.json")
        );
    }

    fn allowed(args: &[&str]) -> bool {
        dispatch_args_allowed(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn dispatch_allows_reading_and_service_control_only() {
        assert!(allowed(&["service", "status"]));
        assert!(allowed(&["service", "start"]));
        assert!(allowed(&["service", "status", "--json"]));
        assert!(allowed(&["service", "stop", "--if-idle"]));
        assert!(allowed(&[
            "jobs", "--json", "--state", "running", "--limit", "50"
        ]));
        assert!(allowed(&["status", "0d26110efa99", "--json"]));
        assert!(allowed(&["cancel", "0d26110efa99"]));
        assert!(allowed(&["logs", "0d26110efa99", "--stderr"]));
        assert!(allowed(&["routes", "--json"]));
        assert!(allowed(&["balance", "--json"]));
        assert!(allowed(&["usage", "--json"]));
        assert!(allowed(&["usage", "--json", "--limit", "50"]));
        assert!(allowed(&["config", "--json"]));
        assert!(allowed(&["test", "luna", "--json"]));
        assert!(allowed(&["config", "set", "maxConcurrent", "4"]));
        assert!(allowed(&[
            "config",
            "set",
            "adapters",
            "codex-exec,grok-exec"
        ]));
        assert!(allowed(&["config", "set", "decision.backend", "laya"]));
    }

    #[test]
    fn dispatch_refuses_submitting_applying_and_odd_arguments() {
        assert!(!allowed(&[]));
        assert!(!allowed(&["run", "codex", "--prompt", "x"]));
        assert!(!allowed(&["apply", "0d26110efa99"]));
        assert!(!allowed(&["usage", "--json", "--limit", "5;x"]));
        assert!(!allowed(&["service", "stop", "--force"]));
        assert!(!allowed(&["status", r"..\..\evil", "--json"]));
        assert!(!allowed(&["status", "0d26110efa99", "--cwd", "C:/"]));
        assert!(!allowed(&["jobs", "--state", "Running;x"]));
        assert!(!allowed(&["jobs", "--limit", "99999"]));
        assert!(!allowed(&["config", "set", "requirePick", "false"]));
        assert!(!allowed(&["config", "set", "verifyNamed", "off"]));
        assert!(!allowed(&["config", "set", "adapters", "codex-exec,exec"]));
        assert!(!allowed(&["config", "set", "maxConcurrent", "4; calc"]));
        assert!(!allowed(&["config", "unset", "maxConcurrent"]));
        assert!(!allowed(&["test", "Luna"]));
        assert!(!allowed(&["test", "luna", "--prompt", "x"]));
        assert!(!allowed(&["test"]));
    }
}

use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::{Manager, image::Image};

use crate::{AppState, anchor_popup};

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Serialize)]
pub struct CommandOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

fn home_dir() -> Result<PathBuf, String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .ok_or_else(|| "Home directory unavailable".into())
}

fn relative_path(path: &str) -> Result<PathBuf, String> {
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

async fn allowed_home_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let relative = relative_path(path)?;
    let is_credential = matches!(
        path,
        ".claude/.credentials.json" | ".codex/auth.json" | ".grok/auth.json"
    ) || path == ".codex/models_cache.json";
    let config = load_json(app.clone(), "config".into()).await?;
    // Besides the three login files and the Codex model list, only the exact export file named in settings (a .json file),
    // and the rules file and rules import file in the same folder.
    let export_file = config
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.get("exportPath")?.as_str().map(str::to_owned))
        .and_then(|export| relative_path(&export).ok())
        .filter(|export| export.extension().is_some_and(|ext| ext == "json"));
    let beside_export = |name: &str| export_file.as_deref().map(|export| export.with_file_name(name));
    let allowed = export_file.as_deref() == Some(relative.as_path())
        || beside_export("policy.json").as_deref() == Some(relative.as_path())
        || beside_export("policy-import.json").as_deref() == Some(relative.as_path());
    if !is_credential && !allowed {
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
pub async fn http_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HttpResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("HTTPS is required".into());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https" {
                attempt.follow()
            } else {
                attempt.error("HTTPS is required")
            }
        }))
        .timeout(Duration::from_millis(
            timeout_ms.unwrap_or(30_000).clamp(1, 300_000),
        ))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.request(method, parsed);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "HTTP request failed".to_owned())?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (key.to_string(), value.to_owned()))
        })
        .collect();
    let body = response
        .text()
        .await
        .map_err(|_| "HTTP response decoding failed".to_owned())?;
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
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

fn executable_path(command: &str) -> Result<PathBuf, String> {
    let exe = if cfg!(windows) {
        format!("{command}.exe")
    } else {
        command.to_owned()
    };
    if let Some(path) = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(&exe))
            .find(|path| path.is_file())
    }) {
        return Ok(path);
    }
    #[cfg(windows)]
    {
        let fallback = match command {
            "grok" => home_dir()?.join(".grok/bin/grok.exe"),
            "bws" => home_dir()?.join(".local/bin/bws.exe"),
            "gh" => PathBuf::from("C:/Program Files/GitHub CLI/gh.exe"),
            _ => return Err("Command is not allowed".into()),
        };
        if fallback.is_file() {
            return Ok(fallback);
        }
    }
    Err("Allowed command is unavailable".into())
}

#[tauri::command]
pub async fn run_command(
    command: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    let allowed = (command == "grok" && args == ["models"])
        || (command == "gh" && args == ["auth", "token"])
        || (command == "bws"
            && args.len() == 5
            && args[0] == "secret"
            && args[1] == "list"
            && uuid::Uuid::parse_str(&args[2]).is_ok()
            && args[3] == "-o"
            && args[4] == "json");
    if !allowed {
        return Err("Command and arguments are not allowed".into());
    }
    let mut process = tokio::process::Command::new(executable_path(&command)?);
    process.args(args).kill_on_drop(true);
    #[cfg(windows)]
    {
        process.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(
        Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1, 300_000)),
        process.output(),
    )
    .await
    .map_err(|_| "Command timed out".to_owned())?
    .map_err(|e| e.to_string())?;
    Ok(CommandOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn keyring_entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

/// The one keychain item outside Augur's own that the page may touch: Claude Code's login on macOS.
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

fn check_secret_name(name: &str) -> Result<(), String> {
    let valid = name.split_once('.').is_some_and(|(provider, field)| {
        !provider.is_empty()
            && !field.is_empty()
            && provider
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
            && field
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    });
    if valid {
        Ok(())
    } else {
        Err("Invalid secret name".into())
    }
}

#[tauri::command]
pub async fn keychain_get(
    service: String,
    account: Option<String>,
) -> Result<Option<String>, String> {
    if service != CLAUDE_KEYCHAIN_SERVICE {
        return Err("Keychain item is not allowed".into());
    }
    keychain_read(service, account).await
}

#[tauri::command]
pub async fn keychain_set(service: String, account: String, value: String) -> Result<(), String> {
    if service != CLAUDE_KEYCHAIN_SERVICE {
        return Err("Keychain item is not allowed".into());
    }
    keychain_write(service, account, value).await
}

async fn keychain_read(service: String, account: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let account = account.unwrap_or_else(|| {
            std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .unwrap_or_default()
        });
        match keyring_entry(&service, &account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn keychain_write(service: String, account: String, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        keyring_entry(&service, &account)?
            .set_password(&value)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_get(name: String) -> Result<Option<String>, String> {
    check_secret_name(&name)?;
    keychain_read("augur".into(), Some(name)).await
}

#[tauri::command]
pub async fn secret_set(name: String, value: String) -> Result<(), String> {
    check_secret_name(&name)?;
    keychain_write("augur".into(), name, value).await
}

#[tauri::command]
pub async fn secret_delete(name: String) -> Result<(), String> {
    check_secret_name(&name)?;
    tokio::task::spawn_blocking(
        move || match keyring_entry("augur", &name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    )
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_has(name: String) -> Result<bool, String> {
    Ok(secret_get(name).await?.is_some())
}

fn json_path(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let name = match kind {
        "config" => "config.json",
        "snapshot" => "snapshot.json",
        "alert-state" => "alert-state.json",
        "model-catalog" => "model-catalog.json",
        _ => return Err("Unknown JSON kind".into()),
    };
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_json(app: tauri::AppHandle, kind: String) -> Result<Option<String>, String> {
    match tokio::fs::read_to_string(json_path(&app, &kind)?).await {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn save_json(app: tauri::AppHandle, kind: String, text: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())?;
    atomic_write(&json_path(&app, &kind)?, &text).await
}

#[tauri::command]
pub async fn load_history(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history.jsonl");
    match tokio::fs::read_to_string(path).await {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn save_history(app: tauri::AppHandle, text: String) -> Result<(), String> {
    for line in text.lines() {
        serde_json::from_str::<serde_json::Value>(line).map_err(|e| e.to_string())?;
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history.jsonl");
    atomic_write(&path, &text).await
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

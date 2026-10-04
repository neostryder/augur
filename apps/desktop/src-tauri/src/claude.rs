//! Installs Augur's Claude Code mod and registers Augur's MCP server with Claude Desktop. Each install touches one entry in one file and its removal takes out exactly that entry, leaving everything else in the file as it was.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::Manager;

use crate::commands::{home_dir, relative_path};

const PLUGIN_DIRS: &str = "CLAUDE_CODE_PLUGIN_DIRS";
const LIST_SEP: char = if cfg!(windows) { ';' } else { ':' };

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// The version of the mod copied into ~/.augur/claude-mod, when Claude Code's settings load it.
    code: Option<String>,
    /// The version of the mod this build carries.
    bundled: Option<String>,
    /// Whether Claude Desktop's config names Augur's MCP server.
    desktop: bool,
    /// Whether this build has an MCP server to register (the Windows dispatch service).
    desktop_possible: bool,
}

fn mod_dir(home: &Path) -> PathBuf {
    home.join(".augur").join("claude-mod")
}

fn settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

fn desktop_config_path(home: &Path) -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Claude")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Claude")
    } else {
        home.join(".config/Claude")
    }
    .join("claude_desktop_config.json")
}

fn bundled_mod(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("claude-mod");
    dir.join(".claude-plugin/plugin.json").is_file().then_some(dir)
}

fn mcp_command(app: &tauri::AppHandle) -> Option<PathBuf> {
    let cmd = std::env::var_os("AUGUR_SERVICE_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().resource_dir().ok().map(|d| d.join("service")))?
        .join("augur-mcp.cmd");
    cmd.is_file().then_some(cmd)
}

fn plugin_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(".claude-plugin/plugin.json")).ok()?;
    serde_json::from_str::<Value>(&text).ok()?.get("version")?.as_str().map(str::to_owned)
}

/// Reads a JSON settings file. A missing file reads as an empty object; one that does not parse is an error, so it is never overwritten.
fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) if value.is_object() => Ok(value),
            _ => Err(format!("{} is not valid JSON, so Augur left it alone", path.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    let tmp = path.with_extension("json.augur-tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b }
}

fn object<'a>(parent: &'a mut Value, key: &str) -> Option<&'a mut Map<String, Value>> {
    let map = parent.as_object_mut()?;
    map.entry(key).or_insert_with(|| json!({})).as_object_mut()
}

/// Adds `dir` to the plugin folder list in a settings.json value. Returns whether anything changed.
fn add_plugin_dir(settings: &mut Value, dir: &str) -> bool {
    let Some(env) = object(settings, "env") else { return false };
    let current = env.get(PLUGIN_DIRS).and_then(Value::as_str).unwrap_or("");
    let mut dirs: Vec<&str> = current.split(LIST_SEP).filter(|d| !d.trim().is_empty()).collect();
    if dirs.iter().any(|d| same_path(d.trim(), dir)) {
        return false;
    }
    dirs.push(dir);
    let joined = dirs.join(&LIST_SEP.to_string());
    env.insert(PLUGIN_DIRS.into(), Value::String(joined));
    true
}

/// Takes `dir` out of the plugin folder list, dropping the variable and the env block when they end up empty.
fn remove_plugin_dir(settings: &mut Value, dir: &str) -> bool {
    let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) else { return false };
    let Some(current) = env.get(PLUGIN_DIRS).and_then(Value::as_str) else { return false };
    let dirs: Vec<&str> = current.split(LIST_SEP).filter(|d| !d.trim().is_empty()).collect();
    let kept: Vec<&str> = dirs.iter().copied().filter(|d| !same_path(d.trim(), dir)).collect();
    if kept.len() == dirs.len() {
        return false;
    }
    if kept.is_empty() {
        env.remove(PLUGIN_DIRS);
    } else {
        env.insert(PLUGIN_DIRS.into(), Value::String(kept.join(&LIST_SEP.to_string())));
    }
    if env.is_empty() {
        settings.as_object_mut().map(|s| s.remove("env"));
    }
    true
}

fn has_plugin_dir(settings: &Value, dir: &str) -> bool {
    settings
        .pointer(&format!("/env/{PLUGIN_DIRS}"))
        .and_then(Value::as_str)
        .is_some_and(|list| list.split(LIST_SEP).any(|d| same_path(d.trim(), dir)))
}

fn set_mcp(config: &mut Value, command: &str) -> bool {
    let Some(servers) = object(config, "mcpServers") else { return false };
    let entry = json!({ "command": command });
    if servers.get("augur") == Some(&entry) {
        return false;
    }
    servers.insert("augur".into(), entry);
    true
}

/// Removes the `augur` server only when it is the one Augur added, so a hand-made entry under that name stays.
fn remove_mcp(config: &mut Value, command: &str) -> bool {
    if !mcp_is(config, command) {
        return false;
    }
    let servers = config.get_mut("mcpServers").and_then(Value::as_object_mut);
    servers.is_some_and(|s| s.remove("augur").is_some())
}

fn mcp_is(config: &Value, command: &str) -> bool {
    config
        .pointer("/mcpServers/augur/command")
        .and_then(Value::as_str)
        .is_some_and(|c| same_path(c, command))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn claude_status(app: tauri::AppHandle) -> Result<ClaudeStatus, String> {
    let home = home_dir()?;
    let dir = mod_dir(&home);
    let loaded = read_json(&settings_path(&home)).is_ok_and(|s| has_plugin_dir(&s, &dir.to_string_lossy()));
    let command = mcp_command(&app);
    let desktop = command.as_ref().is_some_and(|c| {
        read_json(&desktop_config_path(&home)).is_ok_and(|cfg| mcp_is(&cfg, &c.to_string_lossy()))
    });
    Ok(ClaudeStatus {
        code: if loaded { plugin_version(&dir) } else { None },
        bundled: bundled_mod(&app).and_then(|d| plugin_version(&d)),
        desktop,
        desktop_possible: command.is_some(),
    })
}

/// Copies the mod to ~/.augur/claude-mod, tells it where the usage file and the app are, and adds that folder to the plugin folders in Claude Code's settings. Run again after an update, it refreshes the copy.
#[tauri::command]
pub fn claude_code_install(app: tauri::AppHandle, export_path: String) -> Result<(), String> {
    let home = home_dir()?;
    let usage = home.join(relative_path(&export_path)?);
    let source = bundled_mod(&app).ok_or("This build does not include the Claude Code mod")?;
    let dir = mod_dir(&home);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    copy_dir(&source, &dir).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let info = json!({ "usageFile": usage.to_string_lossy(), "exe": exe.to_string_lossy() });
    write_json(&dir.join("augur-app.json"), &info)?;
    let path = settings_path(&home);
    let mut settings = read_json(&path)?;
    if add_plugin_dir(&mut settings, &dir.to_string_lossy()) {
        write_json(&path, &settings)?;
    }
    Ok(())
}

#[tauri::command]
pub fn claude_code_remove() -> Result<(), String> {
    let home = home_dir()?;
    let dir = mod_dir(&home);
    let path = settings_path(&home);
    let mut settings = read_json(&path)?;
    if remove_plugin_dir(&mut settings, &dir.to_string_lossy()) {
        write_json(&path, &settings)?;
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn claude_desktop_install(app: tauri::AppHandle) -> Result<(), String> {
    let command = mcp_command(&app).ok_or("This build does not include the MCP server")?;
    let path = desktop_config_path(&home_dir()?);
    let mut config = read_json(&path)?;
    if set_mcp(&mut config, &command.to_string_lossy()) {
        write_json(&path, &config)?;
    }
    Ok(())
}

#[tauri::command]
pub fn claude_desktop_remove(app: tauri::AppHandle) -> Result<(), String> {
    let Some(command) = mcp_command(&app) else { return Ok(()) };
    let path = desktop_config_path(&home_dir()?);
    let mut config = read_json(&path)?;
    if remove_mcp(&mut config, &command.to_string_lossy()) {
        write_json(&path, &config)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEP: &str = if cfg!(windows) { ";" } else { ":" };

    #[test]
    fn the_plugin_folder_joins_the_list_once_and_leaves_with_nothing_else_touched() {
        let mut settings = json!({ "model": "opus", "env": { "OTHER": "1", PLUGIN_DIRS: "/a" } });
        assert!(add_plugin_dir(&mut settings, "/m"));
        assert!(!add_plugin_dir(&mut settings, "/m"));
        assert_eq!(settings["env"][PLUGIN_DIRS], format!("/a{SEP}/m"));
        assert!(has_plugin_dir(&settings, "/m"));
        assert!(remove_plugin_dir(&mut settings, "/m"));
        assert_eq!(settings, json!({ "model": "opus", "env": { "OTHER": "1", PLUGIN_DIRS: "/a" } }));
    }

    #[test]
    fn an_env_block_added_for_the_mod_goes_away_with_it() {
        let mut settings = json!({ "model": "opus" });
        assert!(add_plugin_dir(&mut settings, "/m"));
        assert!(remove_plugin_dir(&mut settings, "/m"));
        assert_eq!(settings, json!({ "model": "opus" }));
        assert!(!remove_plugin_dir(&mut settings, "/m"));
    }

    #[test]
    fn settings_keep_their_key_order() {
        let mut settings: Value = serde_json::from_str(r#"{"z": 1, "a": 2}"#).unwrap();
        add_plugin_dir(&mut settings, "/m");
        assert!(serde_json::to_string(&settings).unwrap().starts_with(r#"{"z":1,"a":2,"env""#));
    }

    #[test]
    fn only_the_mcp_entry_augur_added_is_removed() {
        let mut config = json!({ "mcpServers": { "other": { "command": "x" } } });
        assert!(set_mcp(&mut config, "C:/augur/augur-mcp.cmd"));
        assert!(!set_mcp(&mut config, "C:/augur/augur-mcp.cmd"));
        assert!(remove_mcp(&mut config, "C:/augur/augur-mcp.cmd"));
        assert_eq!(config, json!({ "mcpServers": { "other": { "command": "x" } } }));
        let mut own = json!({ "mcpServers": { "augur": { "command": "my-own.cmd" } } });
        assert!(!remove_mcp(&mut own, "C:/augur/augur-mcp.cmd"));
    }

    #[test]
    fn a_settings_file_that_does_not_parse_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("augur-claude-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_json(&path).is_err());
        assert_eq!(read_json(&dir.join("missing.json")).unwrap(), json!({}));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

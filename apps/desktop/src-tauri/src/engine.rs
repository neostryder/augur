//! The page's link to the usage engine in the background service. The app runs the packaged `augur bridge` command, which connects to
//! the service as a view. Each JSON line the bridge prints goes to the popup as an `engine-line` event, and each line the popup sends is
//! written to the bridge's input.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::commands::{SERVICE_NODE, service_dir};

#[derive(Default)]
pub struct EngineBridge {
    running: Mutex<Option<(Child, ChildStdin)>>,
    // Bumped on each start, so a bridge that was replaced does not report its end as a failure.
    generation: AtomicU64,
}

/// Starts the bridge, replacing one already running, as a page that reloads needs the whole state again.
#[tauri::command]
pub async fn engine_start(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<(), String> {
    let dir = service_dir(&app)?;
    let mut slot = bridge.running.lock().await;
    if let Some((mut old, _)) = slot.take() {
        let _ = old.kill().await;
    }
    let generation = bridge.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut process = Command::new(dir.join(SERVICE_NODE));
    process.arg(dir.join("augur.mjs")).arg("bridge");
    if let Ok(exe) = std::env::current_exe() {
        process.arg("--app-exe").arg(exe);
    }
    process
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        process.creation_flags(0x0800_0000);
    }
    let mut child = process.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("The engine link has no input")?;
    let stdout = child.stdout.take().ok_or("The engine link has no output")?;
    *slot = Some((child, stdin));
    drop(slot);
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit_to("popup", "engine-line", line);
        }
        if app
            .state::<EngineBridge>()
            .generation
            .load(Ordering::SeqCst)
            == generation
        {
            let _ = app.emit_to("popup", "engine-line", r#"{"t":"exit"}"#);
        }
    });
    Ok(())
}

/// Writes one JSON line from the page to the bridge.
#[tauri::command]
pub async fn engine_send(
    line: String,
    bridge: tauri::State<'_, EngineBridge>,
) -> Result<(), String> {
    if line.contains('\n') {
        return Err("One line at a time".into());
    }
    let mut slot = bridge.running.lock().await;
    let (_, stdin) = slot.as_mut().ok_or("The engine link is not running")?;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

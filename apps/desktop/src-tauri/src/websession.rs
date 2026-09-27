//! Signed-in browser sessions for providers that show usage only on their own account pages.
//!
//! A visible window lets the user sign in once; the session cookies stay in the app's own
//! webview profile. Reading opens a hidden window on the account page, where an injected
//! script collects the numbers and hands them back by navigating to a sentinel address, which
//! the window's navigation handler intercepts. No IPC is exposed to the provider's pages.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::Url;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

const CACHE_FOR: Duration = Duration::from_secs(600);
const WATCH_EVERY: Duration = Duration::from_secs(5);
const WATCH_FOR: Duration = Duration::from_secs(900);
const READ_TIMEOUT: Duration = Duration::from_secs(45);
// The reader script navigates here with its findings; the navigation is intercepted and never loads.
const REPORT_HOST: &str = "augur.invalid";

struct Site {
    title: &'static str,
    sign_in_url: &'static str,
    read_url: &'static str,
    script: &'static str,
    timeout_message: &'static str,
}

fn site(id: &str) -> Option<Site> {
    match id {
        "typesafe" => Some(Site {
            title: "Sign in to TypeSafe",
            sign_in_url: "https://console.typesafe.ai/",
            read_url: "https://console.typesafe.ai/settings/billing",
            script: TYPESAFE_SCRIPT,
            timeout_message: "Could not read the TypeSafe billing page within 45 seconds. Check that you are still signed in under Jev in settings.",
        }),
        _ => None,
    }
}

// Runs on each page load in the reader window. A Cloudflare check that passes on its own loads the
// billing page, where the script runs again. When the numbers are missing, `reason` says what was on
// screen instead: a Cloudflare check that did not pass, a sign-in page, or a billing page without a balance.
const TYPESAFE_SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  const report = (payload) => { location.href = 'https://augur.invalid/report?data=' + encodeURIComponent(JSON.stringify(payload)); };
  const challenged = () => /just a moment|attention required/i.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
  const signInPage = () => !!document.querySelector('input[type=password], input[type=email]') || /sign[-_]?in|log[-_]?in|auth/i.test(location.pathname);
  // The billing page has labeled the balance "Credit Balance" and, since 2026-09-27, "Available credits".
  const BALANCE = 'Available credits|Credit Balance';
  const run = async () => {
    if (location.hostname !== 'console.typesafe.ai') { report({ signedIn: false, reason: 'signin' }); return; }
    let text = '', challenge = false;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      challenge = challenged();
      text = document.body ? document.body.innerText : '';
      if (!challenge && new RegExp(BALANCE, 'i').test(text)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (challenge) { report({ signedIn: false, reason: 'challenge' }); return; }
    if (!new RegExp(BALANCE, 'i').test(text)) { report({ signedIn: false, reason: signInPage() ? 'signin' : 'nobalance' }); return; }
    const dollars = (label) => {
      const m = text.match(new RegExp('(?:' + label + ')\\s*\\$([\\d,]+(?:\\.\\d+)?)', 'i'));
      return m ? Number(m[1].replace(/,/g, '')) : null;
    };
    let usage = null;
    try { const r = await fetch('/api/usage?granularity=day'); if (r.ok) usage = await r.json(); } catch (e) {}
    const refill = (text.match(/Refills to \$[\d.,]+ when below \$[\d.,]+/i) || [null])[0];
    report({ signedIn: true, balance: dollars(BALANCE), spend7d: dollars('Spend'), refill, usage });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
"#;

#[derive(Default)]
pub struct WebSessions {
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cache: Mutex<HashMap<String, (Instant, Value)>>,
}

#[tauri::command]
pub async fn web_session_sign_in(app: tauri::AppHandle, site: String) -> Result<(), String> {
    let spec = self::site(&site).ok_or("Unknown site")?;
    let label = format!("signin-{site}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let url = spec
        .sign_in_url
        .parse()
        .map_err(|_| "Bad sign-in address")?;
    let window = with_popup_args(
        &app,
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url)),
    )
    .title(spec.title)
    .inner_size(520.0, 760.0)
    .build()
    .map_err(|e| e.to_string())?;
    // Signing in can take a while, with a Cloudflare check first, so the page is read again every few
    // seconds while the window is open. The first signed-in reading refreshes the providers that use it.
    let watcher = app.clone();
    let watched = site.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        while started.elapsed() < WATCH_FOR {
            tokio::time::sleep(WATCH_EVERY).await;
            if watcher
                .get_webview_window(&format!("signin-{watched}"))
                .is_none()
            {
                return;
            }
            let reading = read_site(&watcher, &watched).await;
            if let Ok(Some(value)) = reading {
                if value.get("signedIn") == Some(&Value::Bool(true)) {
                    if let Some(popup) = watcher.get_webview_window("popup") {
                        let _ = popup.emit("web-session-ready", ());
                    }
                    return;
                }
            }
        }
    });
    // Closing the sign-in window forgets the cached reading and refreshes, so new numbers show at once.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(mut cache) = handle.state::<WebSessions>().cache.lock() {
                cache.remove(&site);
            }
            if let Some(popup) = handle.get_webview_window("popup") {
                let _ = popup.emit("refresh-requested", ());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn web_session_read(
    app: tauri::AppHandle,
    site: String,
) -> Result<Option<Value>, String> {
    read_site(&app, &site).await
}

async fn read_site(app: &tauri::AppHandle, site: &str) -> Result<Option<Value>, String> {
    let state = app.state::<WebSessions>();
    let site = site.to_string();
    let spec = self::site(&site).ok_or("Unknown site")?;
    if let Some((at, value)) = state.cache.lock().map_err(|e| e.to_string())?.get(&site) {
        if at.elapsed() < CACHE_FOR {
            return Ok(Some(value.clone()));
        }
    }
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
        if pending.contains_key(&site) {
            return Ok(None);
        }
        pending.insert(site.clone(), tx);
    }
    let label = format!("scrape-{site}");
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.destroy();
    }
    let url = spec.read_url.parse().map_err(|_| "Bad account address")?;
    let handle = app.clone();
    let reporting_site = site.clone();
    let built = with_popup_args(
        app,
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url)),
    )
    // Off screen rather than hidden: Cloudflare's check does not finish in a hidden webview.
    .position(-32000.0, -32000.0)
    .inner_size(1024.0, 768.0)
    .decorations(false)
    .focused(false)
    .skip_taskbar(true)
    .initialization_script(spec.script)
    .on_navigation(move |target| {
        if target.host_str() != Some(REPORT_HOST) {
            return true;
        }
        deliver(&handle, &reporting_site, target);
        false
    })
    .build();
    let result = match built {
        Ok(window) => {
            let answer = tokio::time::timeout(READ_TIMEOUT, rx).await;
            let _ = window.destroy();
            answer.ok().and_then(|r| r.ok())
        }
        Err(e) => {
            state
                .pending
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&site);
            return Err(e.to_string());
        }
    };
    state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&site);
    let Some(value) = result else {
        return Err(spec.timeout_message.into());
    };
    // Only a signed-in reading is kept, so the next refresh after signing in reads the page again.
    if value.get("signedIn") == Some(&Value::Bool(true)) {
        state
            .cache
            .lock()
            .map_err(|e| e.to_string())?
            .insert(site, (Instant::now(), value.clone()));
    }
    Ok(Some(value))
}

// WebView2 windows sharing one profile must be created with the same browser arguments,
// or creation fails with 0x8007139F, so new windows copy the popup's configured arguments.
fn with_popup_args<'a, R: tauri::Runtime, M: Manager<R>>(
    app: &tauri::AppHandle<R>,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "popup")
        .and_then(|w| w.additional_browser_args.clone());
    match args {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    }
}

fn deliver(app: &tauri::AppHandle, site: &str, target: &Url) {
    let Some(data) = target
        .query_pairs()
        .find(|(k, _)| k == "data")
        .map(|(_, v)| v.into_owned())
    else {
        return;
    };
    let Ok(payload) = serde_json::from_str::<Value>(&data) else {
        return;
    };
    let state = app.state::<WebSessions>();
    let sender = state.pending.lock().ok().and_then(|mut p| p.remove(site));
    if let Some(tx) = sender {
        let _ = tx.send(payload);
    }
}

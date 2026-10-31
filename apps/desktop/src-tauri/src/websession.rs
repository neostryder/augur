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
// Limit resets change a few times a month, so they are read far less often than a balance.
const CLAUDE_CACHE_FOR: Duration = Duration::from_secs(6 * 3600);
// A reading that found no sign-in is kept briefly, so a provider that refreshes every minute does not open a window each time.
const SIGNED_OUT_CACHE_FOR: Duration = Duration::from_secs(900);
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
    cache_for: Duration,
    timeout_message: &'static str,
}

fn site(id: &str) -> Option<Site> {
    match id {
        "typesafe" => Some(Site {
            title: "Sign in to TypeSafe",
            sign_in_url: "https://console.typesafe.ai/",
            read_url: "https://console.typesafe.ai/settings/billing",
            script: TYPESAFE_SCRIPT,
            cache_for: CACHE_FOR,
            timeout_message: "Could not read the TypeSafe billing page within 45 seconds. Check that you are still signed in under Jev in settings.",
        }),
        "claude" => Some(Site {
            title: "Sign in to Claude",
            sign_in_url: "https://claude.ai/login",
            read_url: "https://claude.ai/settings/usage",
            script: CLAUDE_SCRIPT,
            cache_for: CLAUDE_CACHE_FOR,
            timeout_message: "Could not read the Claude usage page within 45 seconds. Check that you are still signed in to claude.ai under Claude in settings.",
        }),
        _ => None,
    }
}

// The reader script lives in its own file so the core tests can run it against saved page text.
const TYPESAFE_SCRIPT: &str = include_str!("readers/typesafe.js");
const CLAUDE_SCRIPT: &str = include_str!("readers/claude.js");

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
    // The tray popup hides the moment this window takes focus, and Windows then often leaves a new window behind the
    // browser the user was in. Staying on top keeps the sign-in in front through the identity provider's pages.
    .always_on_top(true)
    .focused(true)
    .build()
    .map_err(|e| e.to_string())?;
    // Signing in can take a while, with a Cloudflare check first, so the account page is read again every
    // few seconds while the window is open, but only once the sign-in window itself is back on the site
    // after the identity provider. Reading earlier opens a second window on the sign-in page every few
    // seconds, which competes with the one being used. The first signed-in reading refreshes the providers
    // that use it.
    let watcher = app.clone();
    let watched = site.clone();
    let home = Url::parse(spec.sign_in_url).ok();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut seen_off_site = false;
        let mut settled = 0;
        while started.elapsed() < WATCH_FOR {
            tokio::time::sleep(WATCH_EVERY).await;
            let Some(signin) = watcher.get_webview_window(&format!("signin-{watched}")) else {
                return;
            };
            if let (Some(home), Ok(current)) = (home.as_ref(), signin.url()) {
                if current.host_str() != home.host_str() {
                    seen_off_site = true;
                    settled = 0;
                    continue;
                }
                // A redirect chain after the identity provider passes through several pages on the site, so the
                // window has to stay on a post-sign-in page for two checks in a row before the account page is read.
                if !landed_after_sign_in(&current, seen_off_site) {
                    settled = 0;
                    continue;
                }
                settled += 1;
                if settled < 2 {
                    continue;
                }
            }
            let reading = read_site(&watcher, &watched, true, false).await;
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
    fresh: Option<bool>,
) -> Result<Option<Value>, String> {
    read_site(&app, &site, false, fresh.unwrap_or(false)).await
}

async fn read_site(
    app: &tauri::AppHandle,
    site: &str,
    fresh: bool,
    skip_cache: bool,
) -> Result<Option<Value>, String> {
    let state = app.state::<WebSessions>();
    let site = site.to_string();
    let spec = self::site(&site).ok_or("Unknown site")?;
    // A reading the user asked for skips the cache, so a change on the account page shows at once.
    if let Some((at, value)) = state
        .cache
        .lock()
        .map_err(|e| e.to_string())?
        .get(&site)
        .filter(|_| !skip_cache)
    {
        let signed_in = value.get("signedIn") == Some(&Value::Bool(true));
        let keep = if signed_in {
            spec.cache_for
        } else if fresh {
            Duration::ZERO
        } else {
            SIGNED_OUT_CACHE_FOR
        };
        if at.elapsed() < keep {
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
    // Never takes focus, so a reading made while the sign-in window is open does not pull it away from the user.
    .focusable(false)
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
    // A signed-out reading is kept only briefly and never served to the sign-in window's own watcher,
    // so signing in shows up at once.
    state
        .cache
        .lock()
        .map_err(|e| e.to_string())?
        .insert(site, (Instant::now(), value.clone()));
    Ok(Some(value))
}

/// Whether the sign-in window, already on the site's own host, is showing a page that follows a sign-in.
/// It is after a visit to another host (Google, an identity provider), or on a page other than the root
/// and the sign-in paths, which is where a session that is still valid lands.
fn landed_after_sign_in(url: &Url, seen_off_site: bool) -> bool {
    if seen_off_site {
        return true;
    }
    let path = url.path().trim_end_matches('/').to_ascii_lowercase();
    !(path.is_empty()
        || [
            "login", "log-in", "log_in", "signin", "sign-in", "sign_in", "signup", "sign-up",
            "auth",
        ]
        .iter()
        .any(|word| path.contains(word)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn landed(url: &str, seen_off_site: bool) -> bool {
        landed_after_sign_in(&Url::parse(url).unwrap(), seen_off_site)
    }

    #[test]
    fn waits_on_the_login_screen_until_the_identity_provider_has_been_visited() {
        assert!(!landed("https://console.typesafe.ai/", false));
        assert!(!landed("https://console.typesafe.ai/login", false));
        assert!(!landed("https://claude.ai/login", false));
        assert!(!landed("https://console.typesafe.ai/auth/callback", false));
    }

    #[test]
    fn reads_when_the_window_comes_back_from_the_identity_provider() {
        assert!(landed("https://console.typesafe.ai/", true));
        assert!(landed("https://console.typesafe.ai/auth/callback", true));
    }

    #[test]
    fn reads_a_session_that_was_still_valid() {
        assert!(landed("https://console.typesafe.ai/dashboard", false));
        assert!(landed("https://claude.ai/new", false));
        assert!(landed("https://console.typesafe.ai/design", false));
    }
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

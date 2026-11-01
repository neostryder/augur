//! Signed-in browser sessions for providers that show usage only on their own account pages.
//!
//! A visible window lets the user sign in once; the session cookies stay in the app's own
//! webview profile. Reading opens a hidden window on the account page, where an injected
//! script collects the numbers and hands them back by navigating to a sentinel address, which
//! the window's navigation handler intercepts. No IPC is exposed to the provider's pages.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
const RETRY_AFTER: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(45);
// The reader script navigates here with its findings; the navigation is intercepted and never loads.
const REPORT_HOST: &str = "augur.invalid";

fn trace(app: &tauri::AppHandle, line: &str) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("signin.log");
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 64 * 1024) {
        let _ = OpenOptions::new().write(true).truncate(true).open(&path);
    }
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    let line = line.replace(['\r', '\n'], " ");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{seconds} {line}");
    }
}

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
// Keep provider pages from closing the sign-in window before the user finishes.
const SIGN_IN_GUARD: &str = "try { Object.defineProperty(window, 'close', { value: function () {}, writable: false, configurable: false }); } catch (e) {}";

struct CachedReading {
    at: Instant,
    value: Value,
    // The ready event forces a provider refresh. Hand that refresh the reading we just collected.
    after_sign_in: bool,
}

#[derive(Default)]
pub struct WebSessions {
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cache: Mutex<HashMap<String, CachedReading>>,
    // An update holds this through installation and restart, after existing sign-ins have ended.
    pub(crate) window_gate: tokio::sync::Mutex<()>,
}

#[tauri::command]
pub async fn web_session_sign_in(app: tauri::AppHandle, site: String) -> Result<(), String> {
    trace(&app, &format!("sign-in requested site={site}"));
    let sessions = app.state::<WebSessions>();
    let _gate = sessions.window_gate.lock().await;
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
    .initialization_script(SIGN_IN_GUARD)
    .build()
    .map_err(|e| {
        trace(
            &app,
            &format!("sign-in window build failed site={site} error={e}"),
        );
        e.to_string()
    })?;
    trace(
        &app,
        &format!("window opened site={site} start_url={}", spec.sign_in_url),
    );
    let succeeded = Arc::new(AtomicBool::new(false));
    let destroyed = Arc::new(AtomicBool::new(false));
    let handle = app.clone();
    let closing_site = site.clone();
    let closing_succeeded = succeeded.clone();
    let closing_destroyed = destroyed.clone();
    // A successful reading is already cached. Only a manual close needs another refresh.
    window.on_window_event(move |event| match event {
        WindowEvent::Destroyed => {
            closing_destroyed.store(true, Ordering::SeqCst);
            let succeeded = closing_succeeded.load(Ordering::SeqCst);
            trace(
                &handle,
                &format!("window destroyed site={closing_site} succeeded={succeeded}"),
            );
            if should_clear_cache_on_destroy(succeeded) {
                if let Ok(mut cache) = handle.state::<WebSessions>().cache.lock() {
                    cache.remove(&closing_site);
                }
                if let Some(popup) = handle.get_webview_window("popup") {
                    let _ = popup.emit("refresh-requested", ());
                }
            }
        }
        WindowEvent::Focused(focused) => {
            trace(
                &handle,
                &format!("window focus site={closing_site} focused={focused}"),
            );
        }
        WindowEvent::CloseRequested { .. } => {
            trace(
                &handle,
                &format!("window close requested site={closing_site}"),
            );
        }
        _ => {}
    });
    // Reading opens a second window on the shared profile. Wait until the visible window has
    // landed after sign-in, and give the user time to proceed after each unsuccessful reading.
    let watcher = app.clone();
    let watched = site;
    let home = Url::parse(spec.sign_in_url).ok();
    tauri::async_runtime::spawn(async move {
        let mut seen_off_site = false;
        let mut settled = 0;
        let mut last_url = None;
        let mut last_url_change = Instant::now();
        let mut last_failed_read = None;
        let mut last_state: Option<String> = None;
        let mut missing_window_logged = false;
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            // Keep this window's lifetime, so closing and reopening the same label cannot revive an old watcher.
            if destroyed.load(Ordering::SeqCst) {
                return;
            }
            let state = format!(
                "visible={:?} focused={:?} minimized={:?}",
                window.is_visible(),
                window.is_focused(),
                window.is_minimized()
            );
            if last_state.as_ref() != Some(&state) {
                trace(&watcher, &format!("window state site={watched} {state}"));
                last_state = Some(state);
            }
            if !missing_window_logged
                && watcher
                    .get_webview_window(&format!("signin-{watched}"))
                    .is_none()
            {
                trace(
                    &watcher,
                    &format!("window missing without destroy event site={watched}"),
                );
                missing_window_logged = true;
            }
            let (Some(home), Ok(current)) = (home.as_ref(), window.url()) else {
                settled = 0;
                continue;
            };
            let now = Instant::now();
            if last_url.as_ref() != Some(&current) {
                trace(
                    &watcher,
                    &format!(
                        "url changed site={watched} host={} path={}",
                        current.host_str().unwrap_or(""),
                        current.path()
                    ),
                );
                last_url_change = now;
                last_url = Some(current.clone());
            }
            if current.host_str() != home.host_str() {
                seen_off_site = true;
                settled = 0;
                continue;
            }
            // Redirects can pass through several pages on the site. Require two consecutive checks
            // on post-sign-in pages, including after an unsuccessful reading.
            if !landed_after_sign_in(&current, seen_off_site) {
                settled = 0;
                continue;
            }
            settled = (settled + 1).min(2);
            if !should_read(now, last_failed_read, last_url_change, settled) {
                continue;
            }
            trace(
                &watcher,
                &format!("settled and about to read site={watched}"),
            );
            let reading = read_site(&watcher, &watched, Some(&destroyed), true).await;
            match &reading {
                Ok(Some(value)) => {
                    let signed_in = value.get("signedIn") == Some(&Value::Bool(true));
                    if let Some(reason) = value.get("reason").and_then(Value::as_str) {
                        trace(
                            &watcher,
                            &format!(
                                "read outcome site={watched} signedIn={signed_in} reason={reason}"
                            ),
                        );
                    } else {
                        trace(
                            &watcher,
                            &format!("read outcome site={watched} signedIn={signed_in}"),
                        );
                    }
                }
                Ok(None) => trace(
                    &watcher,
                    &format!("read outcome site={watched} signedIn=false"),
                ),
                Err(error) => trace(
                    &watcher,
                    &format!("read outcome site={watched} Err={error}"),
                ),
            }
            if destroyed.load(Ordering::SeqCst) {
                return;
            }
            if reading_succeeded(&reading) {
                succeeded.store(true, Ordering::SeqCst);
                trace(
                    &watcher,
                    &format!("destroying window after success site={watched}"),
                );
                let _ = window.destroy();
                if let Some(popup) = watcher.get_webview_window("popup") {
                    let _ = popup.emit("web-session-ready", ());
                }
                return;
            }
            last_failed_read = Some(Instant::now());
            settled = 0;
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
    read_site(&app, &site, None, fresh.unwrap_or(false)).await
}

async fn read_site(
    app: &tauri::AppHandle,
    site: &str,
    sign_in_destroyed: Option<&AtomicBool>,
    skip_cache: bool,
) -> Result<Option<Value>, String> {
    let site = site.to_string();
    // A reading loads the account page in a second window on the same profile. While the sign-in window is open that
    // page redirects to the sign-in flow, and the second flow replaces the first one's cookie, so the first fails
    // with "We couldn't verify your browser". The sign-in window's own watcher is the only reader until it closes.
    if sign_in_destroyed.is_none() && app.get_webview_window(&format!("signin-{site}")).is_some() {
        trace(
            app,
            &format!("read skipped site={site} sign-in window exists"),
        );
        return Ok(None);
    }
    trace(
        app,
        &format!("reader read requested site={site} fresh={skip_cache}"),
    );
    let state = app.state::<WebSessions>();
    let spec = self::site(&site).ok_or("Unknown site")?;
    // A requested reading skips the cache, except for the successful reading handed to the ready refresh.
    if let Some(cached) = state
        .cache
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&site)
    {
        let signed_in = cached.value.get("signedIn") == Some(&Value::Bool(true));
        let keep = if signed_in {
            spec.cache_for
        } else if sign_in_destroyed.is_some() {
            Duration::ZERO
        } else {
            SIGNED_OUT_CACHE_FOR
        };
        if should_use_cached_reading(
            cached.at.elapsed(),
            keep,
            skip_cache,
            cached.after_sign_in,
            sign_in_destroyed.is_some(),
        ) {
            if skip_cache {
                cached.after_sign_in = false;
            }
            return Ok(Some(cached.value.clone()));
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
    // -32000 is the minimized-window position on Windows, so use a plain off-screen position.
    .position(-10000.0, -10000.0)
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
            let _ = window.set_position(tauri::PhysicalPosition::new(-10000, -10000));
            let _ = window.set_ignore_cursor_events(true);
            trace(
                app,
                &format!(
                    "reader window opened site={site} at={:?}",
                    window.outer_position().map(|p| (p.x, p.y))
                ),
            );
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
    let mut cache = state.cache.lock().map_err(|e| e.to_string())?;
    // A manual close may happen during the reading. Do not undo its cache clear when the reader finishes.
    if !sign_in_destroyed.is_some_and(|destroyed| destroyed.load(Ordering::SeqCst)) {
        cache.insert(
            site,
            CachedReading {
                at: Instant::now(),
                value: value.clone(),
                after_sign_in: sign_in_destroyed.is_some()
                    && value.get("signedIn") == Some(&Value::Bool(true)),
            },
        );
    }
    Ok(Some(value))
}

pub(crate) fn has_sign_in_window<'a>(labels: impl IntoIterator<Item = &'a str>) -> bool {
    labels.into_iter().any(|label| label.starts_with("signin-"))
}

fn should_use_cached_reading(
    age: Duration,
    keep: Duration,
    skip_cache: bool,
    after_sign_in: bool,
    watching_sign_in: bool,
) -> bool {
    age < keep && (!skip_cache || (after_sign_in && !watching_sign_in))
}

fn should_read(
    now: Instant,
    last_failed_read: Option<Instant>,
    last_url_change: Instant,
    settled: u8,
) -> bool {
    settled >= 2
        && last_failed_read.is_none_or(|failed| {
            last_url_change > failed || now.duration_since(failed) >= RETRY_AFTER
        })
}

fn reading_succeeded(reading: &Result<Option<Value>, String>) -> bool {
    matches!(reading, Ok(Some(value)) if value.get("signedIn") == Some(&Value::Bool(true)))
}

fn should_clear_cache_on_destroy(succeeded: bool) -> bool {
    !succeeded
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_guard_disables_window_close_without_fetching() {
        assert!(SIGN_IN_GUARD.contains("window"));
        assert!(SIGN_IN_GUARD.contains("close"));
        assert!(!SIGN_IN_GUARD.contains("fetch"));
    }

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

    #[test]
    fn reading_requires_two_settled_checks_even_after_navigation_or_a_long_wait() {
        let failed = Instant::now();
        let later = failed + RETRY_AFTER;
        for settled in [0, 1] {
            assert!(!should_read(later, None, failed, settled));
            assert!(!should_read(later, Some(failed), later, settled));
        }
        assert!(should_read(later, None, failed, 2));
    }

    #[test]
    fn an_unchanged_page_backs_off_until_the_retry_pause_has_passed() {
        let failed = Instant::now();
        assert!(!should_read(failed + WATCH_EVERY, Some(failed), failed, 2));
        assert!(!should_read(
            failed + RETRY_AFTER - Duration::from_nanos(1),
            Some(failed),
            failed,
            2,
        ));
        assert!(should_read(failed + RETRY_AFTER, Some(failed), failed, 2));
    }

    #[test]
    fn only_a_url_change_after_the_failure_allows_an_early_retry() {
        let changed = Instant::now();
        let failed = changed + WATCH_EVERY;
        let now = failed + WATCH_EVERY;
        assert!(!should_read(now, Some(failed), changed, 2));
        assert!(!should_read(now, Some(failed), failed, 2));
        assert!(should_read(now, Some(failed), now, 2));
    }

    #[test]
    fn each_failure_restarts_the_retry_pause() {
        let first = Instant::now();
        let second = first + RETRY_AFTER;
        assert!(should_read(second, Some(first), first, 2));
        assert!(!should_read(second + WATCH_EVERY, Some(second), first, 2));
    }

    #[test]
    fn readings_continue_after_fifteen_minutes() {
        let started = Instant::now();
        let now = started + Duration::from_secs(3600);
        assert!(should_read(now, None, started, 2));
        assert!(should_read(now, Some(started), started, 2));
    }

    #[test]
    fn only_a_signed_in_reading_completes_sign_in() {
        for reason in ["signin", "challenge", "nobalance", "timeout"] {
            assert!(!reading_succeeded(&Ok(Some(serde_json::json!({
                "signedIn": false, "reason": reason,
            })))));
        }
        assert!(!reading_succeeded(&Err(String::new())));
        assert!(!reading_succeeded(&Ok(None)));
        assert!(!reading_succeeded(&Ok(Some(serde_json::json!({})))));
        assert!(!reading_succeeded(&Ok(Some(
            serde_json::json!({"signedIn": "true"})
        ))));
        assert!(reading_succeeded(&Ok(Some(serde_json::json!({
            "signedIn": true, "balance": 0,
        })))));
    }

    #[test]
    fn successful_close_keeps_the_reading_and_manual_close_clears_it() {
        assert!(!should_clear_cache_on_destroy(true));
        assert!(should_clear_cache_on_destroy(false));
    }

    #[test]
    fn the_ready_refresh_uses_the_successful_reading_even_when_forced() {
        assert!(should_use_cached_reading(
            Duration::ZERO,
            CACHE_FOR,
            true,
            true,
            false,
        ));
        // Once handed off, another forced refresh can collect a new reading.
        assert!(!should_use_cached_reading(
            Duration::ZERO,
            CACHE_FOR,
            true,
            false,
            false,
        ));
        assert!(should_use_cached_reading(
            Duration::ZERO,
            CACHE_FOR,
            false,
            false,
            false,
        ));
    }

    #[test]
    fn a_watcher_requires_a_new_reading_and_an_expired_reading_is_never_handed_off() {
        assert!(!should_use_cached_reading(
            Duration::ZERO,
            CACHE_FOR,
            true,
            true,
            true,
        ));
        assert!(!should_use_cached_reading(
            CACHE_FOR, CACHE_FOR, true, true, false,
        ));
    }

    #[test]
    fn updates_wait_for_either_sign_in_window_but_not_the_popup_or_readers() {
        assert!(has_sign_in_window(["popup", "signin-typesafe"]));
        assert!(has_sign_in_window(["signin-claude", "scrape-claude"]));
        assert!(!has_sign_in_window([
            "popup",
            "scrape-typesafe",
            "scrape-claude",
        ]));
        assert!(!has_sign_in_window([]));
    }
}

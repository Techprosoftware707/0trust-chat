//! lumen-widget-harness — the Android/iOS apps' call path, on a Linux host.
//!
//! It does what the Lumen mobile apps do through `matrix-sdk-ffi` (matrix-rust-sdk
//! commit 2a3db80e99fe322b9849325a182dc8a634fb20d4 = sdk-android 26.09.28), with the
//! FFI's thin wrappers inlined (bindings/matrix-sdk-ffi/src/widget.rs):
//!
//! 1. `ClientBuilder` with the deployment's CA added through
//!    `add_root_certificates` (never `disable_ssl_verification`), a passphrase-
//!    protected SQLite store, refresh-token handling;
//! 2. SSO completion: `SsoHandler::finish(callbackUrl)` =
//!    `matrix_auth().login_with_sso_callback(url)` with the `loginToken` the
//!    portal returned;
//! 3. sync like the apps: `SyncService` (matrix-sdk-ui; native sliding sync
//!    discovered from `/versions`, the apps' `SlidingSyncVersionBuilder::
//!    DiscoverNative`), join the room and subscribe to it in the room list
//!    service (what opening the call's room does in the apps);
//! 4. `WidgetSettings::new(widgetId, initAfterContentLoad = true, rawUrl)`,
//!    `generate_webview_url(settings, room, ClientProperties)`,
//!    `WidgetDriver::new(settings)` (= `make_widget_driver`) and
//!    `driver.run(room, provider)` (= `WidgetDriver.run`), where the provider
//!    returns exactly `get_element_call_required_permissions(userId, deviceId)`
//!    (see permissions.rs);
//! 5. the native bridge: every widget → driver message goes to
//!    `WidgetDriverHandle::send`, every `WidgetDriverHandle::recv` message goes
//!    to the widget. Here the WebView is replaced by stdio: driver → widget
//!    messages are written to stdout, one JSON message per line; widget →
//!    driver messages are read from stdin, one per line. The exceptions are the
//!    two MatrixRTC actions this SDK revision can't serve against a Lumen server
//!    (MSC4533 SFU token, MSC4515 RTC transports), which the native layer
//!    answers itself — see native_rtc.rs.
//!
//! Logs go to stderr and never contain tokens, keys or message contents.
//! Test tooling only — not shipped in any app.

// The SDK's sync future is deeply nested (its own examples raise the limit too).
#![recursion_limit = "256"]

mod native_rtc;
mod permissions;

use std::{
    io::Read as _,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use language_tags::LanguageTag;
use matrix_sdk::{
    Client, RoomState,
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    reqwest::Certificate,
    ruma::{OwnedRoomId, RoomId},
    sliding_sync::VersionBuilder as SlidingSyncVersionBuilder,
    widget::{Capabilities, CapabilitiesProvider, ClientProperties, WidgetDriver, WidgetSettings},
};
use matrix_sdk_ui::sync_service::{State as SyncState, SyncService};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use tracing::{debug, error, info, warn};
use url::Url;

use crate::native_rtc::{FromWidget, NativeRtc};

const SDK_REV: &str = "2a3db80e99fe322b9849325a182dc8a634fb20d4";
const DEFAULT_CA: &str = "/etc/lumen/ca/bundle.crt";
/// The apps' SSO redirect URI (docs/apps/integration.md §1).
const SSO_CALLBACK: &str = "io.lumen.secure:/sso-callback";

const USAGE: &str = "\
usage: lumen-widget-harness --homeserver URL --room ROOM_ID --widget-url URL [options]

  --homeserver URL     homeserver base URL (https://matrix.example.com)
  --login-token TOKEN  m.login.token from the SSO redirect (or env LUMEN_LOGIN_TOKEN)
  --room ROOM_ID       room to join and run the call widget in
  --widget-url URL     the call widget page (…/index.html); the harness appends the
                       widget URL parameters of docs/apps/integration.md §6.2
  --ca-file PATH       extra trusted root certificate(s), PEM or DER
                       (default /etc/lumen/ca/bundle.crt if it exists)
  --store-dir PATH     SQLite store directory (default: a new temp dir, deleted on exit)
  --widget-id ID       widget ID (default lumen-call)
  --intent I           start_call | join_existing (default join_existing)
  --video BOOL         true | false (default true)
  --notify N           ring | notification | none (default none)
  --theme T            light | dark (default dark)
  --lang TAG           BCP 47 language (default en-US)
  --client-id ID       widget client ID (default io.lumen.secure.android)
  --device-name NAME   initial device display name
  --info-file PATH     write {webview_url, user_id, device_id, …} here once ready
  --keep-session       don't log out (delete the device) on exit
";

struct Args {
    homeserver: Url,
    login_token: String,
    room_id: OwnedRoomId,
    widget_url: Url,
    ca_file: Option<PathBuf>,
    store_dir: Option<PathBuf>,
    widget_id: String,
    intent: String,
    video: bool,
    notify: String,
    theme: String,
    lang: String,
    client_id: String,
    device_name: String,
    info_file: Option<PathBuf>,
    keep_session: bool,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut it = std::env::args().skip(1);
        let mut homeserver = None;
        let mut login_token = None;
        let mut room = None;
        let mut widget_url = None;
        let mut ca_file = None;
        let mut store_dir = None;
        let mut widget_id = "lumen-call".to_owned();
        let mut intent = "join_existing".to_owned();
        let mut video = true;
        let mut notify = "none".to_owned();
        let mut theme = "dark".to_owned();
        let mut lang = "en-US".to_owned();
        let mut client_id = "io.lumen.secure.android".to_owned();
        let mut device_name = "Lumen widget harness".to_owned();
        let mut info_file = None;
        let mut keep_session = false;
        while let Some(flag) = it.next() {
            let mut val = || it.next().ok_or_else(|| anyhow!("{flag} needs a value\n{USAGE}"));
            match flag.as_str() {
                "--homeserver" => homeserver = Some(Url::parse(&val()?).context("--homeserver")?),
                "--login-token" => login_token = Some(val()?),
                "--room" => room = Some(RoomId::parse(val()?).context("--room")?),
                "--widget-url" => widget_url = Some(Url::parse(&val()?).context("--widget-url")?),
                "--ca-file" => ca_file = Some(PathBuf::from(val()?)),
                "--store-dir" => store_dir = Some(PathBuf::from(val()?)),
                "--widget-id" => widget_id = val()?,
                "--intent" => intent = val()?,
                "--video" => video = val()? == "true",
                "--notify" => notify = val()?,
                "--theme" => theme = val()?,
                "--lang" => lang = val()?,
                "--client-id" => client_id = val()?,
                "--device-name" => device_name = val()?,
                "--info-file" => info_file = Some(PathBuf::from(val()?)),
                "--keep-session" => keep_session = true,
                "-h" | "--help" => {
                    eprint!("{USAGE}");
                    std::process::exit(0);
                }
                other => bail!("unknown argument {other}\n{USAGE}"),
            }
        }
        let login_token = login_token
            .or_else(|| std::env::var("LUMEN_LOGIN_TOKEN").ok())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| anyhow!("--login-token (or LUMEN_LOGIN_TOKEN) is required\n{USAGE}"))?;
        // SAFETY: single-threaded at this point (before the runtime spawns work).
        unsafe { std::env::remove_var("LUMEN_LOGIN_TOKEN") };
        if !matches!(intent.as_str(), "start_call" | "join_existing") {
            bail!("--intent must be start_call or join_existing");
        }
        if !matches!(notify.as_str(), "ring" | "notification" | "none") {
            bail!("--notify must be ring, notification or none");
        }
        let ca_file = ca_file.or_else(|| Path::new(DEFAULT_CA).exists().then(|| PathBuf::from(DEFAULT_CA)));
        Ok(Self {
            homeserver: homeserver.ok_or_else(|| anyhow!("--homeserver is required\n{USAGE}"))?,
            login_token,
            room_id: room.ok_or_else(|| anyhow!("--room is required\n{USAGE}"))?,
            widget_url: widget_url.ok_or_else(|| anyhow!("--widget-url is required\n{USAGE}"))?,
            ca_file,
            store_dir,
            widget_id,
            intent,
            video,
            notify,
            theme,
            lang,
            client_id,
            device_name,
            info_file,
            keep_session,
        })
    }
}

/// The capabilities provider the apps pass to `WidgetDriver.run`: it grants
/// `get_element_call_required_permissions(userId, deviceId)` — no more, and
/// regardless of what the widget asked for (that is what Element X does with
/// the same function, and what docs/apps/integration.md §6.2 specifies).
struct LumenCallCapabilities {
    user_id: String,
    device_id: String,
}

impl CapabilitiesProvider for LumenCallCapabilities {
    async fn acquire_capabilities(&self, requested: Capabilities) -> Capabilities {
        let granted = permissions::element_call_required_permissions(&self.user_id, &self.device_id);
        let req = permissions::capability_strings(&requested);
        let gr = permissions::capability_strings(&granted);
        let refused: Vec<&String> = req.iter().filter(|c| !gr.contains(c)).collect();
        info!(requested = req.len(), granted = gr.len(), "capabilities negotiated (Element Call required set)");
        if !refused.is_empty() {
            info!("capabilities refused (not in the required set): {refused:?}");
        }
        granted
    }
}

fn random_hex(n: usize) -> Result<String> {
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// The certificates handed to `ClientBuilder::add_root_certificates`, one
/// `reqwest::Certificate` per certificate as the FFI builds them. (The FFI
/// tries DER first, then PEM; reqwest's `from_der` does not validate, so PEM
/// input is recognised by its armour here and parsed with `from_pem`.)
fn load_root_certificates(path: &Path) -> Result<Vec<Certificate>> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut out = Vec::new();
    if text.contains("-----BEGIN CERTIFICATE-----") {
        for block in text.split_inclusive("-----END CERTIFICATE-----") {
            let Some(start) = block.find("-----BEGIN CERTIFICATE-----") else { continue };
            let pem = &block[start..];
            let cert = Certificate::from_pem(pem.as_bytes())
                .with_context(|| format!("parsing a certificate in {}", path.display()))?;
            out.push(cert);
        }
    } else {
        out.push(Certificate::from_der(&bytes).context("parsing DER certificate")?);
    }
    if out.is_empty() {
        bail!("no certificate in {}", path.display());
    }
    Ok(out)
}

/// The widget URL template of docs/apps/integration.md §6.2, written with the
/// placeholders `generate_webview_url` substitutes at this SDK revision
/// (crates/matrix-sdk/src/widget/settings/url_params.rs).
fn raw_widget_url(args: &Args) -> Result<(String, String)> {
    let origin = args.widget_url.origin().ascii_serialization();
    if origin == "null" {
        bail!("--widget-url must have an origin (http(s))");
    }
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let sep = if args.widget_url.query().is_some() { '&' } else { '?' };
    let raw = format!(
        "{base}{sep}widgetId=$matrix_widget_id&parentUrl={parent}&roomId=$matrix_room_id\
         &userId=$matrix_user_id&deviceId=$org.matrix.msc2873.matrix_device_id\
         &baseUrl=$org.matrix.msc4039.matrix_base_url&lang=$org.matrix.msc2873.client_language\
         &theme=$org.matrix.msc2873.client_theme&intent={intent}&video={video}&notify={notify}",
        base = args.widget_url.as_str(),
        parent = enc(&origin),
        intent = args.intent,
        video = args.video,
        notify = args.notify,
    );
    Ok((raw, origin))
}

/// A short, content-free description of a widget-API message for the log.
fn describe(raw: &str) -> String {
    match serde_json::from_str::<Value>(raw) {
        Ok(v) => {
            let api = v.get("api").and_then(Value::as_str).unwrap_or("?");
            let action = v.get("action").and_then(Value::as_str).unwrap_or("?");
            let kind = if v.get("response").is_some() { "response" } else { "request" };
            let ty = v.pointer("/data/type").and_then(Value::as_str).unwrap_or("");
            let err = if v.pointer("/response/error").is_some() { " ERROR" } else { "" };
            format!("{api}/{action} {kind}{}{err}", if ty.is_empty() { String::new() } else { format!(" ({ty})") })
        }
        Err(_) => "unparseable message".to_owned(),
    }
}

async fn run(args: Args) -> Result<()> {
    // --- client (FFI ClientBuilder::build) ---------------------------------------
    let (store_dir, temp_store) = match &args.store_dir {
        Some(d) => (d.clone(), false),
        None => (std::env::temp_dir().join(format!("lumen-widget-harness-{}", random_hex(8)?)), true),
    };
    std::fs::create_dir_all(&store_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&store_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    // The apps keep a random store passphrase in Keystore/Keychain (ADR 0003 D7).
    let passphrase = random_hex(32)?;

    let mut builder = Client::builder()
        .homeserver_url(args.homeserver.as_str())
        .sqlite_store(&store_dir, Some(&passphrase))
        .handle_refresh_tokens()
        .sliding_sync_version_builder(SlidingSyncVersionBuilder::DiscoverNative)
        .with_encryption_settings(EncryptionSettings {
            auto_enable_cross_signing: true,
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            auto_enable_backups: false,
        });
    if let Some(ca) = &args.ca_file {
        let certs = load_root_certificates(ca)?;
        info!(count = certs.len(), file = %ca.display(), "trusting additional root certificate(s)");
        builder = builder.add_root_certificates(certs);
    }
    let client = builder.build().await.context("building the client")?;

    let result = run_with_client(&client, &args).await;

    if !args.keep_session && client.session_meta().is_some() {
        match tokio::time::timeout(Duration::from_secs(10), client.matrix_auth().logout()).await {
            Ok(Ok(_)) => info!("logged out (device deleted)"),
            Ok(Err(e)) => warn!("logout failed: {e}"),
            Err(_) => warn!("logout timed out"),
        }
    }
    drop(client);
    if temp_store {
        let _ = std::fs::remove_dir_all(&store_dir);
    }
    result
}

async fn run_with_client(client: &Client, args: &Args) -> Result<()> {
    // --- sign-in: SsoHandler::finish(callbackUrl) ----------------------------------
    let mut callback = Url::parse(SSO_CALLBACK)?;
    callback.query_pairs_mut().append_pair("loginToken", &args.login_token);
    client
        .matrix_auth()
        .login_with_sso_callback(callback.into())
        .map_err(|_| anyhow!("invalid SSO callback URL"))?
        .initial_device_display_name(&args.device_name)
        .await
        .context("m.login.token login failed")?;
    let user_id = client.user_id().context("no user ID after login")?.to_string();
    let device_id = client.device_id().context("no device ID after login")?.to_string();
    info!(%user_id, %device_id, "logged in");

    // Cross-signing bootstrap (auto_enable_cross_signing), like the apps' first
    // sign-in; the server allows the first upload without UIA (MSC3967).
    client.encryption().wait_for_e2ee_initialization_tasks().await;
    match client.encryption().cross_signing_status().await {
        Some(s) if s.is_complete() => info!("cross-signing set up; this device is signed by its user"),
        other => warn!("cross-signing not complete: {other:?}"),
    }

    // --- sync (SyncService, as the apps) and join ---------------------------------
    let sync_service = SyncService::builder(client.clone()).build().await.context("building the sync service")?;
    sync_service.start().await;
    let mut sync_state = sync_service.state();
    let room = match client.get_room(&args.room_id) {
        Some(r) if r.state() == RoomState::Joined => r,
        _ => {
            info!("joining the room");
            client.join_room_by_id(&args.room_id).await.context("joining the room")?
        }
    };
    sync_service.room_list_service().set_room_subscriptions(&[args.room_id.as_ref()]).await;
    // Wait until the joined room's state has arrived through the sync.
    for _ in 0..150 {
        if let SyncState::Error(e) = sync_state.get() {
            bail!("sync failed: {e}");
        }
        if room.state() == RoomState::Joined && !room.encryption_state().is_unknown() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let encrypted = room.latest_encryption_state().await.map(|s| s.is_encrypted()).unwrap_or(false);
    info!(encrypted, sync = ?sync_state.next_now(), "room joined");

    // --- widget (generate_webview_url, make_widget_driver) -----------------------
    let (raw_url, origin) = raw_widget_url(args)?;
    let settings = WidgetSettings::new(args.widget_id.clone(), true, &raw_url).context("widget URL")?;
    let props = ClientProperties::new(&args.client_id, LanguageTag::parse(&args.lang).ok(), Some(args.theme.clone()));
    let webview_url = settings.generate_webview_url(&room, props).await.context("generate_webview_url")?;
    let (driver, handle) = WidgetDriver::new(settings);
    let handle = Arc::new(handle);
    let native = Arc::new(NativeRtc::new(client.clone(), args.room_id.clone(), &user_id, &device_id, &args.widget_id));

    // Single writer for stdout: driver messages and native answers.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            let line = if line.contains('\n') {
                serde_json::from_str::<Value>(&line).map(|v| v.to_string()).unwrap_or_else(|_| line.replace('\n', " "))
            } else {
                line
            };
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });

    // driver → widget
    let to_widget = {
        let handle = handle.clone();
        let native = native.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            while let Some(msg) = handle.recv().await {
                let msg = native.on_to_widget(msg);
                debug!("driver → widget: {}", describe(&msg));
                if out_tx.send(msg).is_err() {
                    break;
                }
            }
            info!("widget driver closed its channel");
        })
    };

    // widget → driver
    let from_widget = {
        let handle = handle.clone();
        let native = native.clone();
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                debug!("widget → driver: {}", describe(line));
                match native.on_from_widget(line) {
                    FromWidget::Forward => {
                        if !handle.send(line.to_owned()) {
                            warn!("widget driver is no longer running");
                            break;
                        }
                    }
                    FromWidget::Intercepted(request) => {
                        let native = native.clone();
                        let out_tx = out_tx.clone();
                        tokio::spawn(async move {
                            let _ = out_tx.send(native.answer(request).await);
                        });
                    }
                }
            }
            info!("stdin closed (widget gone)");
        })
    };

    if let Some(path) = &args.info_file {
        let info = json!({
            "webview_url": webview_url.as_str(),
            "widget_origin": origin,
            "widget_id": args.widget_id,
            "user_id": user_id,
            "device_id": device_id,
            "room_id": args.room_id.as_str(),
            "room_encrypted": encrypted,
            "homeserver": client.homeserver().as_str(),
            "matrix_rust_sdk_rev": SDK_REV,
        });
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&info)?)?;
        std::fs::rename(&tmp, path)?;
    }
    info!("ready: widget driver running (widget id {})", args.widget_id);

    let provider = LumenCallCapabilities { user_id: user_id.clone(), device_id: device_id.clone() };
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        r = driver.run(room.clone(), provider) => info!("widget driver stopped ({})", if r.is_ok() { "ok" } else { "error" }),
        _ = from_widget => {},
        _ = tokio::signal::ctrl_c() => info!("interrupted"),
        _ = sigterm.recv() => info!("terminated"),
    }
    to_widget.abort();
    drop(out_tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    let _ = tokio::time::timeout(Duration::from_secs(5), sync_service.stop()).await;
    Ok(())
}

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("LUMEN_HARNESS_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,matrix_sdk_crypto=error,lumen_widget_harness=info")),
        )
        .init();
    let args = match Args::parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e:#}");
            return ExitCode::from(2);
        }
    };
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("tokio runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(run(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

//! The two MatrixRTC widget-API actions the native layer answers itself,
//! because the widget driver of matrix-rust-sdk 2a3db80e (= sdk-android
//! 26.09.28) cannot serve them against a Lumen server:
//!
//! 1. `org.matrix.msc4533.rtc_livekit_get_token` (MSC4533). The Lumen call
//!    widget runs the web client's call code on matrix-js-sdk 44's
//!    `RoomWidgetClient`, which asks its host for the LiveKit SFU token over
//!    the widget API, because a widget has no access token. The driver has no
//!    such action (`FromWidgetRequest` in crates/matrix-sdk/src/widget/machine/
//!    from_widget.rs) and does not list `org.matrix.msc4533` in
//!    `supported_api_versions`. The OpenID route the driver does support
//!    (`get_openid`) can't replace it: lk-jwt-service's standalone `/get_token`
//!    derives a different LiveKit identity (`legacy_livekit_identity_for(user,
//!    device, member)`) than the homeserver-proxied MSC4195 endpoint
//!    (`livekit_identity_for(user, member)`), and the latter is what
//!    matrix-js-sdk 44 expects for a `{type: "livekit", url}` membership — web
//!    participants would treat the widget's media connection as having no call
//!    membership and not play it.
//!
//! 2. `org.matrix.msc4515.get_rtc_transports` (MSC4515). The driver implements
//!    it through `Client::discover_rtc_transports`, but ruma-client-api 0.25
//!    (used at this revision) only models the older `{type: "livekit",
//!    livekit_service_url}` transport. A Lumen homeserver advertises the
//!    MSC4195 form `{type: "livekit", url: "wss://rtc.<domain>"}`, and the SDK
//!    rejects the whole response ("missing field `livekit_service_url`"), so
//!    the widget would never learn the SFU URL.
//!
//! The native bridge (Android/iOS: next to `WidgetDriverHandle`) therefore:
//!
//! - adds `org.matrix.msc4533` to the driver's `supported_api_versions` answer;
//! - grants `org.matrix.msc4533.rtc_livekit_get_token` only when the widget
//!   asked for it during capability negotiation, and adds it to the
//!   `notify_capabilities` approval the driver sends;
//! - answers `rtc_livekit_get_token` with
//!   `POST /_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`
//!   (the request data as the body, verbatim, as MSC4533 specifies) using the
//!   session's access token — only for the room the driver is bound to and
//!   only for this device's member ID (`<user>:<device>`); the widget gets the
//!   response (a room-scoped SFU JWT), never the access token;
//! - answers `get_rtc_transports`, if the driver approved
//!   `org.matrix.msc4515.rtc_transports`, with the `rtc_transports` of
//!   `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports`
//!   (verbatim; entries without a string `type` are dropped).
//!
//! `rtc_livekit_delegate_delayed_leave` is not granted (Lumen doesn't use it)
//! and goes to the driver, which rejects it as unknown.

use std::sync::atomic::{AtomicBool, Ordering};

use matrix_sdk::{Client, ruma::OwnedRoomId};
use serde_json::{Value, json};
use tracing::{info, warn};

pub const MSC4533_API_VERSION: &str = "org.matrix.msc4533";
pub const MSC4533_GET_TOKEN: &str = "org.matrix.msc4533.rtc_livekit_get_token";
pub const MSC4515_GET_TRANSPORTS: &str = "org.matrix.msc4515.get_rtc_transports";
const MSC4515_CAPABILITY: &str = "org.matrix.msc4515.rtc_transports";
const GET_TOKEN_PATH: &str = "_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token";
const TRANSPORTS_PATH: &str = "_matrix/client/unstable/org.matrix.msc4143/rtc/transports";

/// What to do with a message the widget sent.
pub enum FromWidget {
    /// Pass it to the SDK's widget driver unchanged.
    Forward,
    /// A request the native layer answers itself (see [`NativeRtc::answer`]).
    Intercepted(Value),
}

pub struct NativeRtc {
    client: Client,
    room_id: OwnedRoomId,
    member_id: String,
    widget_id: String,
    token_capability_requested: AtomicBool,
    transports_capability_approved: AtomicBool,
}

fn refuse(message: &str) -> Value {
    json!({ "message": message })
}

impl NativeRtc {
    pub fn new(client: Client, room_id: OwnedRoomId, user_id: &str, device_id: &str, widget_id: &str) -> Self {
        Self {
            client,
            room_id,
            member_id: format!("{user_id}:{device_id}"),
            widget_id: widget_id.to_owned(),
            token_capability_requested: AtomicBool::new(false),
            transports_capability_approved: AtomicBool::new(false),
        }
    }

    /// Inspects a widget → driver message.
    pub fn on_from_widget(&self, raw: &str) -> FromWidget {
        let Ok(v) = serde_json::from_str::<Value>(raw) else { return FromWidget::Forward };
        if v.get("widgetId").and_then(Value::as_str) != Some(self.widget_id.as_str()) {
            return FromWidget::Forward;
        }
        let api = v.get("api").and_then(Value::as_str);
        let action = v.get("action").and_then(Value::as_str);
        let is_response = v.get("response").is_some();

        // The widget's answer to the driver's `capabilities` request.
        if api == Some("toWidget") && action == Some("capabilities") && is_response {
            let asked = v
                .pointer("/response/capabilities")
                .and_then(Value::as_array)
                .is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some(MSC4533_GET_TOKEN)));
            self.token_capability_requested.store(asked, Ordering::SeqCst);
        }

        if api == Some("fromWidget") && !is_response && matches!(action, Some(MSC4533_GET_TOKEN | MSC4515_GET_TRANSPORTS)) {
            return FromWidget::Intercepted(v);
        }
        FromWidget::Forward
    }

    /// Inspects a driver → widget message; returns the (possibly amended)
    /// message.
    pub fn on_to_widget(&self, raw: String) -> String {
        let Ok(mut v) = serde_json::from_str::<Value>(&raw) else { return raw };
        let api = v.get("api").and_then(Value::as_str).map(str::to_owned);
        let action = v.get("action").and_then(Value::as_str).map(str::to_owned);
        let mut changed = false;

        // The driver's answer to the widget's `supported_api_versions` request.
        if api.as_deref() == Some("fromWidget") && action.as_deref() == Some("supported_api_versions") {
            if let Some(list) = v.pointer_mut("/response/supported_versions").and_then(Value::as_array_mut) {
                if !list.iter().any(|x| x.as_str() == Some(MSC4533_API_VERSION)) {
                    list.push(json!(MSC4533_API_VERSION));
                    changed = true;
                }
            }
        }

        // The driver tells the widget which capabilities were approved.
        if api.as_deref() == Some("toWidget") && action.as_deref() == Some("notify_capabilities") {
            if let Some(list) = v.pointer_mut("/data/approved").and_then(Value::as_array_mut) {
                let has = |list: &Vec<Value>, c: &str| list.iter().any(|x| x.as_str() == Some(c));
                self.transports_capability_approved.store(has(list, MSC4515_CAPABILITY), Ordering::SeqCst);
                if self.token_capability_requested.load(Ordering::SeqCst) && !has(list, MSC4533_GET_TOKEN) {
                    list.push(json!(MSC4533_GET_TOKEN));
                    changed = true;
                    info!("native: granted {MSC4533_GET_TOKEN} (own room, own member ID only)");
                }
            }
        }

        if changed { serde_json::to_string(&v).unwrap_or(raw) } else { raw }
    }

    /// Answers an intercepted request; returns the widget-API response message.
    pub async fn answer(&self, mut request: Value) -> String {
        let action = request.get("action").and_then(Value::as_str).unwrap_or_default().to_owned();
        let data = request.get("data").cloned().unwrap_or(Value::Null);
        let result = match action.as_str() {
            MSC4533_GET_TOKEN => self.get_token(data).await,
            MSC4515_GET_TRANSPORTS => self.get_transports().await,
            _ => Err(refuse("Unknown action")),
        };
        let response = match result {
            Ok(body) => {
                info!("native: answered {action}");
                body
            }
            Err(e) => {
                let why = e.get("message").and_then(|m| m.as_str()).unwrap_or("?").to_owned();
                warn!("native: refused {action}: {why}");
                json!({ "error": e })
            }
        };
        request["response"] = response;
        serde_json::to_string(&request).expect("JSON values always serialise")
    }

    async fn get_transports(&self) -> Result<Value, Value> {
        if !self.transports_capability_approved.load(Ordering::SeqCst) {
            return Err(refuse("Missing capability"));
        }
        let body = self.homeserver_request("GET", TRANSPORTS_PATH, None).await?;
        let transports: Vec<Value> = body
            .get("rtc_transports")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|t| t.get("type").and_then(Value::as_str).is_some()).cloned().collect())
            .unwrap_or_default();
        if transports.is_empty() {
            return Err(refuse("The homeserver does not advertise any RTC transport"));
        }
        Ok(json!({ "rtc_transports": transports }))
    }

    async fn get_token(&self, data: Value) -> Result<Value, Value> {
        if !self.token_capability_requested.load(Ordering::SeqCst) {
            return Err(refuse("Missing capability"));
        }
        let Some(body) = data.as_object() else { return Err(refuse("Invalid request body")) };
        if body.get("room_id").and_then(Value::as_str) != Some(self.room_id.as_str()) {
            return Err(refuse("Tokens are only issued for the widget's own room"));
        }
        if body.get("member_id").and_then(Value::as_str) != Some(self.member_id.as_str()) {
            return Err(refuse("Tokens are only issued for this device's call membership"));
        }
        let res = self.homeserver_request("POST", GET_TOKEN_PATH, Some(&data)).await?;
        if res.get("jwt").and_then(Value::as_str).is_none() {
            return Err(refuse("The homeserver returned no token"));
        }
        Ok(res)
    }

    /// An authenticated client-server API call with this session's access
    /// token (what the apps do with `Client.session()` and their HTTP stack).
    async fn homeserver_request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, Value> {
        let Some(access_token) = self.client.access_token() else { return Err(refuse("Not logged in")) };
        let url = self.client.homeserver().join(path).map_err(|_| refuse("Invalid homeserver URL"))?;
        let http = self.client.http_client();
        let mut req = if method == "POST" { http.post(url.clone()) } else { http.get(url.clone()) };
        req = req.bearer_auth(access_token);
        if let Some(b) = body {
            req = req.header("content-type", "application/json").body(serde_json::to_vec(b).expect("JSON values always serialise"));
        }
        let res = req
            .send()
            .await
            .map_err(|e| refuse(&format!("Couldn't reach the homeserver: {}", e.without_url())))?;
        let status = res.status().as_u16();
        let bytes = res.bytes().await.map_err(|_| refuse("Couldn't read the homeserver's answer"))?;
        let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status == 200 && parsed.is_object() {
            return Ok(parsed);
        }
        // The shape a matrix-widget-api host uses for a failed homeserver call,
        // so matrix-js-sdk turns it into a MatrixError with the real status.
        Err(json!({
            "message": format!("The homeserver refused the request (HTTP {status})"),
            "matrix_api_error": {
                "http_status": status,
                "http_headers": {},
                "url": url.as_str(),
                "response": if parsed.is_object() { parsed } else { json!({}) },
            }
        }))
    }
}

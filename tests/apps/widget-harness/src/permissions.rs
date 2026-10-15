//! The capabilities the Lumen apps grant to the call widget.
//!
//! This is a line-for-line port of `get_element_call_required_permissions`
//! from matrix-rust-sdk commit 2a3db80e99fe322b9849325a182dc8a634fb20d4,
//! `bindings/matrix-sdk-ffi/src/widget.rs` lines 148-276 (the function the
//! Android/iOS apps call through `matrix-sdk-ffi` as
//! `getElementCallRequiredPermissions(userId, deviceId)`), followed by the
//! FFI's `From<WidgetCapabilities> for matrix_sdk::widget::Capabilities` and
//! `From<WidgetEventFilter> for matrix_sdk::widget::Filter` conversions
//! (same file, lines 347-359 and 390-410).
//!
//! Copyright 2025 The Matrix.org Foundation C.I.C., Apache License 2.0
//! (http://www.apache.org/licenses/LICENSE-2.0). Ported, not modified: the
//! FFI type `WidgetEventFilter` is reproduced as a private enum so that the
//! list below reads exactly like the original.

use matrix_sdk::{
    ruma::events::{MessageLikeEventType, StateEventType},
    widget::{Capabilities, Filter, MessageLikeEventFilter, StateEventFilter, ToDeviceEventFilter},
};

/// `bindings/matrix-sdk-ffi/src/widget.rs`: `enum WidgetEventFilter`.
#[derive(Clone)]
enum WidgetEventFilter {
    MessageLikeWithType { event_type: String },
    StateWithType { event_type: String },
    StateWithTypeAndStateKey { event_type: String, state_key: String },
    ToDevice { event_type: String },
}

/// `bindings/matrix-sdk-ffi/src/widget.rs`: `impl From<WidgetEventFilter> for
/// matrix_sdk::widget::Filter` (the `RoomMessageWithMsgtype` arm is unused by
/// the call permissions and omitted).
impl From<WidgetEventFilter> for Filter {
    fn from(value: WidgetEventFilter) -> Self {
        match value {
            WidgetEventFilter::MessageLikeWithType { event_type } => {
                Self::MessageLike(MessageLikeEventFilter::WithType(event_type.into()))
            }
            WidgetEventFilter::StateWithType { event_type } => {
                Self::State(StateEventFilter::WithType(event_type.into()))
            }
            WidgetEventFilter::StateWithTypeAndStateKey { event_type, state_key } => {
                Self::State(StateEventFilter::WithTypeAndStateKey(event_type.into(), state_key))
            }
            WidgetEventFilter::ToDevice { event_type } => {
                Self::ToDevice(ToDeviceEventFilter { event_type: event_type.into() })
            }
        }
    }
}

/// `get_element_call_required_permissions(own_user_id, own_device_id)`,
/// converted to the SDK's `Capabilities` exactly as the FFI's
/// `WidgetDriver::run` does with the value its capabilities provider returns.
pub fn element_call_required_permissions(own_user_id: &str, own_device_id: &str) -> Capabilities {
    let own_user_id = own_user_id.to_owned();
    let own_device_id = own_device_id.to_owned();

    let read_send = vec![
        // To read and send rageshake requests from other room members
        WidgetEventFilter::MessageLikeWithType {
            event_type: "org.matrix.rageshake_request".to_owned(),
        },
        // To read and send encryption keys
        WidgetEventFilter::ToDevice { event_type: "io.element.call.encryption_keys".to_owned() },
        // TODO change this to the appropriate to-device version once ready
        // remove this once all matrixRTC call apps supports to-device
        // encryption.
        WidgetEventFilter::MessageLikeWithType {
            event_type: "io.element.call.encryption_keys".to_owned(),
        },
        // To read and send custom EC reactions. They are different to normal
        // `m.reaction` because they can be send multiple times to the same
        // event.
        WidgetEventFilter::MessageLikeWithType {
            event_type: "io.element.call.reaction".to_owned(),
        },
        // This allows send raise hand reactions.
        WidgetEventFilter::MessageLikeWithType {
            event_type: MessageLikeEventType::Reaction.to_string(),
        },
        // This allows to detect if someone does not raise their hand anymore.
        WidgetEventFilter::MessageLikeWithType {
            event_type: MessageLikeEventType::RoomRedaction.to_string(),
        },
        // This allows declining an incoming call and detect if someone declines a call.
        WidgetEventFilter::MessageLikeWithType {
            event_type: MessageLikeEventType::RtcDecline.to_string(),
        },
    ];

    let read: Vec<WidgetEventFilter> = vec![
        // To compute the current state of the matrixRTC session.
        WidgetEventFilter::StateWithType { event_type: StateEventType::CallMember.to_string() },
        // To display the name of the room.
        WidgetEventFilter::StateWithType { event_type: StateEventType::RoomName.to_string() },
        // To detect leaving/kicked room members during a call.
        WidgetEventFilter::StateWithType { event_type: StateEventType::RoomMember.to_string() },
        // To decide whether to encrypt the call streams based on the room encryption setting.
        WidgetEventFilter::StateWithType { event_type: StateEventType::RoomEncryption.to_string() },
        // This allows the widget to check the room version, so it can know
        // about version-specific auth rules (namely MSC3779).
        WidgetEventFilter::StateWithType { event_type: StateEventType::RoomCreate.to_string() },
    ]
    .into_iter()
    .chain(read_send.clone())
    .collect();

    let send: Vec<WidgetEventFilter> = vec![
        // To notify other users that a call has started.
        WidgetEventFilter::MessageLikeWithType {
            event_type: MessageLikeEventType::RtcNotification.to_string(),
        },
        // Also for call notifications, except this is the deprecated
        // fallback type which Element Call still sends. Deprecated for now,
        // kept for backward compatibility as widgets will send both
        // CallNotify and RtcNotification.
        WidgetEventFilter::MessageLikeWithType {
            event_type: MessageLikeEventType::CallNotify.to_string(),
        },
        // To send the call participation state event (main MatrixRTC
        // event). This is required for legacy state events (using only one
        // event for all devices with a membership array). TODO: remove once
        // legacy call member events are sunset.
        WidgetEventFilter::StateWithTypeAndStateKey {
            event_type: StateEventType::CallMember.to_string(),
            state_key: own_user_id.clone(),
        },
        // `delayed_event`` version for session memberhips
        // [MSC3779](https://github.com/matrix-org/matrix-spec-proposals/pull/3779),
        // with no leading underscore.
        WidgetEventFilter::StateWithTypeAndStateKey {
            event_type: StateEventType::CallMember.to_string(),
            state_key: format!("{own_user_id}_{own_device_id}"),
        },
        // Same as above for [MSC3779] and
        // [MSC4143](https://github.com/matrix-org/matrix-spec-proposals/pull/4143),
        // with application suffix
        WidgetEventFilter::StateWithTypeAndStateKey {
            event_type: StateEventType::CallMember.to_string(),
            state_key: format!("{own_user_id}_{own_device_id}_m.call"),
        },
        // The same as above but with an underscore. To work around the
        // issue that state events starting with `@` have to be Matrix id's
        // but we use mxId+deviceId.
        WidgetEventFilter::StateWithTypeAndStateKey {
            event_type: StateEventType::CallMember.to_string(),
            state_key: format!("_{own_user_id}_{own_device_id}"),
        },
        // Same as above for [MSC4143], with application suffix
        WidgetEventFilter::StateWithTypeAndStateKey {
            event_type: StateEventType::CallMember.to_string(),
            state_key: format!("_{own_user_id}_{own_device_id}_m.call"),
        },
    ]
    .into_iter()
    .chain(read_send)
    .collect();

    // `impl From<WidgetCapabilities> for matrix_sdk::widget::Capabilities`
    Capabilities {
        read: read.into_iter().map(Into::into).collect(),
        send: send.into_iter().map(Into::into).collect(),
        requires_client: true,
        update_delayed_event: true,
        send_delayed_event: true,
        download_file: true,
        rtc_transports: true,
    }
}

/// The capability strings of a capability set, as they appear on the wire
/// (the SDK's own `Serialize` impl for `Capabilities`).
pub fn capability_strings(caps: &Capabilities) -> Vec<String> {
    serde_json::to_value(caps)
        .ok()
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same assertions as the FFI's own test
    /// (`element_call_permissions_are_correct`, widget.rs lines 503-570).
    #[test]
    fn element_call_permissions_are_correct() {
        let caps = element_call_required_permissions("@my_user:my_domain.org", "ABCDEFGHI");
        let list = capability_strings(&caps);
        for c in [
            "io.element.requires_client",
            "org.matrix.msc4157.update_delayed_event",
            "org.matrix.msc4157.send.delayed_event",
            "org.matrix.msc2762.receive.state_event:org.matrix.msc3401.call.member",
            "org.matrix.msc2762.receive.state_event:m.room.name",
            "org.matrix.msc2762.receive.state_event:m.room.member",
            "org.matrix.msc2762.receive.state_event:m.room.encryption",
            "org.matrix.msc2762.receive.event:org.matrix.rageshake_request",
            "org.matrix.msc2762.receive.event:io.element.call.encryption_keys",
            "org.matrix.msc2762.receive.state_event:m.room.create",
            "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#@my_user:my_domain.org",
            "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#@my_user:my_domain.org_ABCDEFGHI",
            "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#@my_user:my_domain.org_ABCDEFGHI_m.call",
            "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#_@my_user:my_domain.org_ABCDEFGHI",
            "org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#_@my_user:my_domain.org_ABCDEFGHI_m.call",
            "org.matrix.msc2762.send.event:org.matrix.rageshake_request",
            "org.matrix.msc2762.send.event:io.element.call.encryption_keys",
            "org.matrix.msc2762.receive.event:org.matrix.msc4310.rtc.decline",
            "org.matrix.msc2762.send.event:org.matrix.msc4310.rtc.decline",
            "org.matrix.msc4039.download_file",
        ] {
            assert!(list.iter().any(|x| x == c), "missing {c}");
        }
    }
}

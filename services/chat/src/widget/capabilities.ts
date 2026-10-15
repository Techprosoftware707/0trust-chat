/** The capabilities the call widget asks the native widget driver for. */
import type { ICapabilities } from "matrix-js-sdk";
import { CALL_MEMBER_EVENT, RTC_DECLINE_EVENT, RTC_NOTIFICATION_EVENT } from "../calls/rtc";
import type { WidgetParams } from "./params";

/** MatrixRTC media keys (to-device, encrypted by the native SDK). */
const ENCRYPTION_KEYS_EVENT = "io.element.call.encryption_keys";

/**
 * What the call needs, and nothing else; all of it is inside the set the apps grant
 * (getElementCallRequiredPermissions), plus the SFU token the native layer serves (MSC4533).
 */
export function widgetCapabilities(p: Pick<WidgetParams, "userId" | "deviceId">): ICapabilities {
  return {
    receiveState: [CALL_MEMBER_EVENT, "m.room.member", "m.room.name", "m.room.encryption", "m.room.create"].map((eventType) => ({ eventType })),
    // own membership only: `_@user_DEVICE_m.call` (MSC3779 room versions use no underscore)
    sendState: [`_${p.userId}_${p.deviceId}_m.call`, `${p.userId}_${p.deviceId}_m.call`].map((stateKey) => ({ eventType: CALL_MEMBER_EVENT, stateKey })),
    sendEvent: [RTC_NOTIFICATION_EVENT, RTC_DECLINE_EVENT],
    receiveEvent: [RTC_DECLINE_EVENT],
    sendToDevice: [ENCRYPTION_KEYS_EVENT],
    receiveToDevice: [ENCRYPTION_KEYS_EVENT],
    sendDelayedEvents: true,
    updateDelayedEvents: true,
    rtcTransports: true,
    rtcLivekitGetToken: true,
  };
}

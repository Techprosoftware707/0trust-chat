import { useEffect, useState } from "react";
import { createLocalAudioTrack, type LocalAudioTrack } from "livekit-client";
import { Info, Mic, MicOff } from "lucide-react";
import { audioCaptureOptions, describeMediaError } from "../../calls/media";
import { getCallPrefs, setCallPrefs, useCallPrefs } from "../../calls/prefs";
import { useActiveCall } from "../../calls/store";
import { CallDeviceSettings } from "../calls/CallDeviceSettings";
import { Toggle } from "./Toggle";

/** Settings → Calls: devices, audio quality, video quality, ringtone. */
export function CallsTab() {
  const prefs = useCallPrefs();
  const active = useActiveCall();
  const [test, setTest] = useState<LocalAudioTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The microphone is only opened for a test the user asked for, and closed when leaving the tab.
  useEffect(() => () => test?.stop(), [test]);
  const inCall = !!active && active.getSnapshot().phase !== "ended";
  return (
    <div className="settings-section stack">
      <h3>Calls</h3>
      <Toggle
        label="Ring for incoming calls"
        description="Play a ringtone for 1:1 calls while this tab is open. Conversations you muted never ring."
        checked={prefs.ringtone}
        onChange={(on) => setCallPrefs({ ringtone: on })}
      />
      {inCall ? (
        <p className="alert alert-info small">
          <Info aria-hidden="true" />
          <span>You're in a call: change devices from the call's settings button so they apply immediately. Changes here apply to your next call.</span>
        </p>
      ) : (
        <div className="cluster">
          {test ? (
            <button type="button" className="btn btn-sm" onClick={() => setTest(null)}>
              <MicOff aria-hidden="true" /> Stop microphone test
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                setError(null);
                try {
                  setTest(await createLocalAudioTrack(audioCaptureOptions(getCallPrefs())));
                } catch (e) {
                  setError(describeMediaError(e, "microphone"));
                }
              }}
            >
              <Mic aria-hidden="true" /> Test microphone
            </button>
          )}
          {error ? <p className="form-error small">{error}</p> : null}
        </div>
      )}
      <CallDeviceSettings
        micTrack={test?.mediaStreamTrack ?? null}
        onDevice={async (kind, id) => {
          if (kind === "audioinput" && test) await test.restartTrack({ ...audioCaptureOptions(getCallPrefs(), id) });
        }}
        onAudioPrefs={async () => {
          if (test) await test.restartTrack(audioCaptureOptions(getCallPrefs(), (test.mediaStreamTrack.getSettings().deviceId as string | undefined) ?? null));
        }}
      />
      <p className="small muted alert alert-info">
        <Info aria-hidden="true" />
        <span>
          Calls are end-to-end encrypted: audio and video are encrypted on your device with keys exchanged over your encrypted Matrix sessions, and the media server only forwards data it can't decode. These preferences are stored in this browser only.
        </span>
      </p>
    </div>
  );
}

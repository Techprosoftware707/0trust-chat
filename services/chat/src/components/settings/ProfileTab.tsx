import { useEffect, useId, useRef, useState } from "react";
import { Camera, Info, Trash2 } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { invalidateProfile, useUserProfile } from "../../hooks/matrix";
import { getUploadLimit, inlineKind } from "../../matrix/media";
import { formatBytes } from "../../lib/format";
import { errorMessage } from "../../lib/errors";
import { Avatar } from "../primitives/Avatar";
import { CopyButton } from "../primitives/CopyButton";
import { Spinner } from "../primitives/Spinner";

export function ProfileTab() {
  const { client, userId } = useMatrix();
  const { displayName, avatarMxc } = useUserProfile(client, userId);
  const [name, setName] = useState(displayName);
  const [busy, setBusy] = useState<null | "name" | "avatar">(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => setName(displayName), [displayName]);

  const saveName = async () => {
    setBusy("name");
    setMessage(null);
    try {
      await client.setDisplayName(name.trim());
      invalidateProfile(userId);
      setMessage({ kind: "ok", text: "Display name saved." });
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const uploadAvatar = async (f: File) => {
    setMessage(null);
    if (inlineKind(f.type) !== "image") {
      setMessage({ kind: "error", text: "Choose a PNG, JPEG, GIF or WebP image." });
      return;
    }
    const limit = await getUploadLimit(client);
    if (limit !== null && f.size > limit) {
      setMessage({ kind: "error", text: `That image is larger than the server's limit (${formatBytes(limit)}).` });
      return;
    }
    setBusy("avatar");
    try {
      const { content_uri } = await client.uploadContent(f, { type: f.type, name: f.name });
      await client.setAvatarUrl(content_uri);
      invalidateProfile(userId);
      setMessage({ kind: "ok", text: "Profile picture updated." });
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-section stack">
      <h3>Profile</h3>
      <div className="profile-row">
        <Avatar name={displayName} seed={userId} mxc={avatarMxc} size={80} />
        <div className="stack-sm">
          <div className="cluster">
            <button type="button" className="btn btn-sm" onClick={() => file.current?.click()} disabled={busy !== null}>
              {busy === "avatar" ? <Spinner size="sm" /> : <Camera aria-hidden="true" />} Upload picture
            </button>
            {avatarMxc ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy("avatar");
                  try {
                    await client.setAvatarUrl("");
                    invalidateProfile(userId);
                    setMessage({ kind: "ok", text: "Profile picture removed." });
                  } catch (e) {
                    setMessage({ kind: "error", text: errorMessage(e) });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Trash2 aria-hidden="true" /> Remove
              </button>
            ) : null}
          </div>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadAvatar(f);
            }}
          />
        </div>
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void saveName();
        }}
      >
        <div className="field">
          <label htmlFor={`${id}-name`}>Display name</label>
          <div className="input-row">
            <input id={`${id}-name`} type="text" maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={busy !== null || !name.trim() || name.trim() === displayName}>
              {busy === "name" ? <Spinner size="sm" /> : null} Save
            </button>
          </div>
        </div>
      </form>
      {message ? (
        <p className={message.kind === "ok" ? "form-ok" : "form-error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
      <div className="field">
        <span className="label">Matrix ID</span>
        <div className="input-row">
          <code className="codebox grow">{userId}</code>
          <CopyButton text={userId} />
        </div>
      </div>
      <p className="alert alert-info small">
        <Info aria-hidden="true" />
        <span>Your display name and picture are public profile data: the server and people you share conversations with can see them. They aren't end-to-end encrypted.</span>
      </p>
    </div>
  );
}

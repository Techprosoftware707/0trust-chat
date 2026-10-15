import { useEffect, useState } from "react";
import { useClient } from "../../matrix/context";
import { avatarBlobUrl } from "../../matrix/media";
import { initials } from "../../lib/format";

const HUES = 6;

function hueIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % HUES;
}

export type PresenceDot = "online" | "unavailable" | "offline" | null;

interface AvatarProps {
  name: string;
  /** Stable seed for the placeholder colour (user or room ID). */
  seed: string;
  mxc?: string | null;
  size?: number;
  presence?: PresenceDot;
  className?: string;
}

export function Avatar({ name, seed, mxc, size = 40, presence = null, className }: AvatarProps) {
  const client = useClient();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (mxc) {
      // Fetch at 2x for crisp rendering on high-DPI screens.
      void avatarBlobUrl(client, mxc, Math.min(256, Math.max(64, size * 2))).then((u) => alive && setSrc(u));
    }
    return () => {
      alive = false;
    };
  }, [client, mxc, size]);
  return (
    <span className={`avatar avatar-h${hueIndex(seed)}${className ? ` ${className}` : ""}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {src ? <img src={src} alt="" width={size} height={size} draggable={false} /> : <span className="avatar-initial">{initials(name)}</span>}
      {presence ? <span className={`presence-dot presence-${presence}`} /> : null}
    </span>
  );
}

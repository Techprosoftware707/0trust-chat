import { ExternalLink } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { BrandLogo } from "../BrandLogo";
import { useUi } from "../UiContext";

/** The public website's security page (the portal's site), when the deployment has one. */
export function securityPageUrl(portalUrl: string | null): string | null {
  if (!portalUrl) return null;
  try {
    return new URL("/security/", portalUrl).toString();
  } catch {
    return null;
  }
}

export function AboutTab() {
  const { client, config } = useMatrix();
  const ui = useUi();
  const cryptoVersion = client.getCrypto()?.getVersion();
  const security = securityPageUrl(config.portalUrl);
  const verified = ui.security.thisDeviceVerified;
  return (
    <div className="settings-section stack">
      <div className="about-head">
        <BrandLogo size={48} />
        <div>
          <h3>{config.brand.name}</h3>
          <p className="small muted">
            Web app version {__APP_VERSION__} <span className="badge badge-accent badge-plain about-new">New · Built on Matrix</span>
          </p>
        </div>
      </div>
      <section className="about-card" aria-labelledby="about-matrix">
        <h4 id="about-matrix">{config.brand.shortName} runs on Matrix</h4>
        <p className="small">
          <a href="https://matrix.org" target="_blank" rel="noopener noreferrer">
            Matrix
          </a>{" "}
          is the open standard for secure, decentralised messaging. Conversations are end-to-end encrypted by default (Olm and Megolm, in the
          audited vodozemac library), you verify people and devices by comparing emoji, and your encrypted key backup opens only with the recovery key
          you hold.
        </p>
        <dl className="kv">
          <dt>Homeserver</dt>
          <dd className="break">{client.getHomeserverUrl()}</dd>
          <dt>Matrix ID</dt>
          <dd className="break">{client.getUserId()}</dd>
          <dt>Session ID</dt>
          <dd className="mono">{client.getDeviceId()}</dd>
          <dt>Encryption</dt>
          <dd>
            {cryptoVersion ? (
              <>
                On · {ui.security.loading ? "checking this session…" : verified ? "this session is verified" : "this session isn't verified yet"}
                <span className="subtle xsmall about-crypto">{cryptoVersion}</span>
              </>
            ) : (
              "Unavailable"
            )}
          </dd>
        </dl>
      </section>
      <p className="small muted">
        Because it's Matrix, there's no lock-in: you can talk with people on other Matrix servers when your server federates, and sign in with other
        Matrix apps such as Element.
        {config.calls.enabled ? " Calls use MatrixRTC, with every audio and video frame end-to-end encrypted: the media server only forwards ciphertext." : ""}
      </p>
      <p className="small muted">
        {config.brand.shortName} servers include WireGuard for private administration: the operator console is only reachable through an encrypted
        tunnel. Your chats don't travel through it — they're protected end to end by Matrix.
      </p>
      <div className="cluster">
        {security ? (
          <a className="btn btn-sm" href={security} target="_blank" rel="noopener noreferrer">
            How {config.brand.shortName} keeps you safe <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
        {config.helpUrl ? (
          <a className="btn btn-sm" href={config.helpUrl} target="_blank" rel="noopener noreferrer">
            Help <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
        {config.privacyUrl ? (
          <a className="btn btn-sm" href={config.privacyUrl} target="_blank" rel="noopener noreferrer">
            Privacy policy <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
        <a className="btn btn-sm" href="/licenses/third-party.md" target="_blank" rel="noopener noreferrer">
          Third-party licences <ExternalLink aria-hidden="true" />
        </a>
        {config.portalUrl ? (
          <a className="btn btn-sm" href={config.portalUrl} target="_blank" rel="noopener noreferrer">
            Account portal <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

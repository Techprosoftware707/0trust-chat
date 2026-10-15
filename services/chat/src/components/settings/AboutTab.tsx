import { ExternalLink } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { BrandLogo } from "../BrandLogo";

export function AboutTab() {
  const { client, config } = useMatrix();
  const cryptoVersion = client.getCrypto()?.getVersion();
  return (
    <div className="settings-section stack">
      <div className="about-head">
        <BrandLogo size={48} />
        <div>
          <h3>{config.brand.name}</h3>
          <p className="small muted">Web app version {__APP_VERSION__}</p>
        </div>
      </div>
      <p>
        {config.brand.shortName} is a standard <a href="https://matrix.org" target="_blank" rel="noopener noreferrer">Matrix</a> client. Your
        conversations live on your homeserver and work with any other Matrix app; messages in encrypted conversations are encrypted and
        decrypted only on your devices, using the audited Matrix encryption library (vodozemac).
      </p>
      <dl className="kv">
        <dt>Homeserver</dt>
        <dd className="break">{client.getHomeserverUrl()}</dd>
        <dt>Signed in as</dt>
        <dd className="break">{client.getUserId()}</dd>
        <dt>Device ID</dt>
        <dd className="mono">{client.getDeviceId()}</dd>
        <dt>Encryption</dt>
        <dd>{cryptoVersion ?? "Unavailable"}</dd>
      </dl>
      <div className="cluster">
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
        {config.portalUrl ? (
          <a className="btn btn-sm" href={config.portalUrl} target="_blank" rel="noopener noreferrer">
            Account portal <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

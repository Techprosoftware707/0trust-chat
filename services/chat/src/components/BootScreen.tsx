import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { AppConfig } from "../config";
import { BrandLogo } from "./BrandLogo";
import { Spinner } from "./primitives/Spinner";

export function BootScreen({
  config,
  status,
  error,
  children,
}: {
  config: AppConfig | null;
  status: string | null;
  error?: string;
  children?: ReactNode;
}) {
  return (
    <main className="boot" aria-busy={status ? "true" : "false"}>
      <div className="boot-card">
        <BrandLogo size={56} className="boot-logo" />
        {config ? <p className="boot-brand">{config.brand.name}</p> : null}
        {status ? <Spinner label={status} /> : null}
        {error ? (
          <div className="alert alert-danger" role="alert">
            <TriangleAlert aria-hidden="true" />
            <p>{error}</p>
          </div>
        ) : null}
        {children}
      </div>
    </main>
  );
}

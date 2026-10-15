import { useState } from "react";
import fallbackLogo from "@branding/logo.svg";

/** The operator's logo from /brand/logo.svg, falling back to the bundled copy. */
export function BrandLogo({ size = 32, className = "brand-logo" }: { size?: number; className?: string }) {
  const [src, setSrc] = useState("/brand/logo.svg");
  return (
    <img
      className={className}
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => {
        if (src !== fallbackLogo) setSrc(fallbackLogo);
      }}
    />
  );
}

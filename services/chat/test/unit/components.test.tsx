import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EncryptionBadge } from "../../src/components/room/RoomHeader";

describe("encryption labels", () => {
  it("labels rooms honestly", () => {
    expect(renderToStaticMarkup(<EncryptionBadge encrypted={true} />)).toContain("Encrypted");
    const off = renderToStaticMarkup(<EncryptionBadge encrypted={false} />);
    expect(off).toContain("Not encrypted");
    expect(off).toContain("badge-warning");
    // While the crypto layer hasn't answered yet we claim nothing.
    expect(renderToStaticMarkup(<EncryptionBadge encrypted={null} />)).toBe("");
  });
});

describe("links to the website", () => {
  it("points 'Learn more' at the website's security page, only when there is a website", async () => {
    const { securityPageUrl } = await import("../../src/components/settings/AboutTab");
    expect(securityPageUrl("https://lumen.example")).toBe("https://lumen.example/security/");
    expect(securityPageUrl("https://lumen.example/portal/")).toBe("https://lumen.example/security/");
    expect(securityPageUrl(null)).toBeNull();
    expect(securityPageUrl("not a url")).toBeNull();
  });
});

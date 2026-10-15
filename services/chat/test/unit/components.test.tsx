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

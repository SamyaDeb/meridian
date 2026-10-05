import { ImageResponse } from "next/og";

// Share card (decision D4): text only, no product screenshots. Colours = globals.css --bg / --text / --muted / --brand.
export const alt = "Meridian · per-block funding on Monad";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          background: "#050507",
          color: "#eceef4",
        }}
      >
        <div style={{ display: "flex", width: 72, height: 8, borderRadius: 4, background: "#836ef9", marginBottom: 40 }} />
        <div style={{ display: "flex", fontSize: 112, fontWeight: 700, letterSpacing: -3 }}>Meridian</div>
        <div style={{ display: "flex", fontSize: 48, marginTop: 16, color: "#8b90a3" }}>per-block funding on Monad</div>
      </div>
    ),
    size,
  );
}

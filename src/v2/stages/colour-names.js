// A plain-words name for a Lab colour ("light warm grey", "deep blue"). Used where
// no model named the colour: the no-model perception baseline and reports.

export function colourName({ L, a, b }) {
  const chroma = Math.hypot(a, b);
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const tone = L > 85 ? "pale" : L > 65 ? "light" : L > 40 ? "mid" : L > 22 ? "dark" : "deep";

  if (chroma < 6) {
    if (L > 92) return "white";
    if (L < 15) return "black";
    const temp = b > 2 ? "warm " : b < -2 ? "cool " : "";
    return `${tone} ${temp}grey`.replace("pale warm grey", "warm off-white").replace("pale grey", "off-white");
  }
  const family =
    hue < 20 || hue >= 345 ? "pink-red"
    : hue < 50 ? "orange-brown"
    : hue < 70 ? (chroma < 25 ? "beige" : "ochre")
    : hue < 105 ? "yellow-olive"
    : hue < 165 ? "green"
    : hue < 220 ? "teal"
    : hue < 290 ? "blue"
    : "purple";
  const muted = chroma < 18 ? "muted " : "";
  return `${tone} ${muted}${family}`;
}

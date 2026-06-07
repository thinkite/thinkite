import Svg, { G, Path, Rect } from "react-native-svg";

/**
 * Sidecode brand mark — the orange wordmark glyph on a dark rounded tile.
 * Vectored inline (react-native-svg) from the canonical source in
 * packages/website (`BrandMark.astro` / `public/favicon.svg`). Self-contained:
 * it paints its own #111110 background, so it reads identically in light and
 * dark. Inline (not an asset) avoids needing react-native-svg-transformer.
 */
export function SidecodeMark({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 360 360">
      <Rect width={360} height={360} rx={80} fill="#111110" />
      <G transform="translate(180 180) scale(0.879) translate(-180 -180)">
        <Path
          d="M116 76.8C116 66.7191 116 61.6786 117.962 57.8282C119.688 54.4413 122.441 51.6876 125.828 49.9619C129.679 48 134.719 48 144.8 48H283.2C293.281 48 298.321 48 302.172 49.9619C305.559 51.6876 308.312 54.4413 310.038 57.8282C312 61.6786 312 66.7191 312 76.8V79.2C312 89.2809 312 94.3214 310.038 98.1718C308.312 101.559 305.559 104.312 302.172 106.038C298.321 108 293.281 108 283.2 108H144.8C134.719 108 129.679 108 125.828 106.038C122.441 104.312 119.688 101.559 117.962 98.1718C116 94.3214 116 89.2809 116 79.2V76.8Z"
          fill="#FF7846"
        />
        <Rect x={48} y={116} width={108} height={40} rx={18} fill="#FFB088" />
        <Path
          d="M48 192.8C48 182.719 48 177.679 49.9619 173.828C51.6876 170.441 54.4413 167.688 57.8282 165.962C61.6786 164 66.7191 164 76.8 164H223.2C233.281 164 238.321 164 242.172 165.962C245.559 167.688 248.312 170.441 250.038 173.828C252 177.679 252 182.719 252 192.8V215.2C252 225.281 252 230.321 250.038 234.172C248.312 237.559 245.559 240.312 242.172 242.038C238.321 244 233.281 244 223.2 244H76.8C66.7191 244 61.6786 244 57.8282 242.038C54.4413 240.312 51.6876 237.559 49.9619 234.172C48 230.321 48 225.281 48 215.2V192.8Z"
          fill="#FF976B"
        />
        <Rect x={180} y={252} width={132} height={60} rx={18} fill="#EE5722" />
      </G>
    </Svg>
  );
}

import { useCurrentFrame } from 'remotion';

const W = 200;
const H = 200;
const CX = 100;
const CY = 100;
const BLADE_COUNT = 3;
const DEG_PER_FRAME = 21; // ~17 frames per full rotation — fast, but not so fast it strobes at 30fps

// Traced directly from the real Tasaki logo mark (public/tasaki logo.png):
// flood-filled one blade, walked its pixel boundary, smoothed the raster
// stair-stepping, and scaled up — not hand-drawn/guessed. No hub circle:
// the three blades meet directly at the center, same as the logo.
const BLADE_PATH = `
  M 105.93 22.06 L 95.63 23.35 L 84.74 25.61 L 74.63 28.39 L 65.67 31.35
  L 57.74 34.35 L 50.59 37.35 L 44.22 40.35 L 38.59 43.35 L 33.74 46.35
  L 29.63 49.35 L 26.45 52.35 L 24.33 55.35 L 23.45 58.35 L 23.59 61.35
  L 24.52 64.35 L 25.82 67.35 L 27.3 70.35 L 28.82 73.35 L 30.45 76.35
  L 32.19 79.35 L 34.07 82.35 L 36.04 85.35 L 38.04 88.35 L 40.04 91.35
  L 42.07 94.35 L 44.26 97.35 L 46.78 100.31 L 49.78 103.09 L 53.19 105.35
  L 56.67 106.65 L 59.74 106.65 L 62.11 105.35 L 63.82 103.09 L 65.15 100.31
  L 66.45 97.35 L 67.85 94.35 L 69.45 91.35 L 71.19 88.35 L 73.04 85.35
  L 74.89 82.35 L 76.67 79.35 L 78.45 76.35 L 80.33 73.35 L 82.45 70.35
  L 84.67 67.35 L 86.89 64.35 L 89.0 61.35 L 91.04 58.35 L 93.07 55.35
  L 95.22 52.35 L 97.59 49.35 L 100.22 46.35 L 103.07 43.35 L 106.04 40.35
  L 109.04 37.35 L 112.04 34.35 L 115.0 31.35 L 117.63 28.39 L 119.15 25.61
  L 118.26 23.35 L 113.89 22.06 Z
`;

export const Fan = ({ startFrame = 0, scale = 1, glow = true }) => {
  const frame = useCurrentFrame();
  const lf = Math.max(0, frame - startFrame);
  const spinDeg = lf * DEG_PER_FRAME;

  return (
    <svg width={W * scale} height={H * scale} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        {/* One lighting gradient per blade, each carrying a gradientTransform
            that cancels that blade's own rotation. Without this, the "shine"
            would be painted onto the blade and spin rigidly with it — real
            reflective objects catch a fixed light source differently
            depending on their current angle, so the highlight has to stay
            put in world-space while the blade rotates underneath it. */}
        {Array.from({ length: BLADE_COUNT }, (_, i) => {
          const bladeAngle = spinDeg + (360 / BLADE_COUNT) * i;
          return (
            <linearGradient
              key={i}
              id={`fanBladeLit-${i}`}
              gradientUnits="userSpaceOnUse"
              x1="55" y1="25" x2="145" y2="175"
              gradientTransform={`rotate(${-bladeAngle} ${CX} ${CY})`}
            >
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="22%" stopColor="#E4EAF0" />
              <stop offset="50%" stopColor="#AEBBC8" />
              <stop offset="78%" stopColor="#7B8A99" />
              <stop offset="100%" stopColor="#57636F" />
            </linearGradient>
          );
        })}

        <radialGradient id="fanGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#F4F7FA" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#F4F7FA" stopOpacity="0" />
        </radialGradient>

        <filter id="fanShadowBlur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>

      {/* soft ambient glow — only safe on a transparent/dark backdrop. On a
          chroma-key green backdrop this translucent circle blends with the
          green in the gaps between blades and won't fully key out, so the
          green-screen composition passes glow={false}. */}
      {glow && <circle cx={CX} cy={CY} r={95} fill="url(#fanGlow)" />}

      {/* soft contact shadow, offset down-right, grounds the fan as a solid
          object instead of a flat cutout floating on the background */}
      <g transform={`rotate(${spinDeg} ${CX} ${CY}) translate(3 5)`} filter="url(#fanShadowBlur)" opacity="0.35">
        {Array.from({ length: BLADE_COUNT }, (_, i) => (
          <path
            key={i}
            d={BLADE_PATH}
            fill="#1A222B"
            transform={`rotate(${(360 / BLADE_COUNT) * i} ${CX} ${CY})`}
          />
        ))}
      </g>

      <g transform={`rotate(${spinDeg} ${CX} ${CY})`}>
        {Array.from({ length: BLADE_COUNT }, (_, i) => (
          <path
            key={i}
            d={BLADE_PATH}
            fill={`url(#fanBladeLit-${i})`}
            transform={`rotate(${(360 / BLADE_COUNT) * i} ${CX} ${CY})`}
          />
        ))}
      </g>
    </svg>
  );
};

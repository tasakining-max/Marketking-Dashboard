import { useCurrentFrame, interpolate } from 'remotion';

// A fin-and-tube AC coil, built as SVG — no asset exists for this in public/,
// same approach as Fan.jsx / Thermometer.jsx. Ribbed fins are drawn as a
// tileable stripe pattern (cheap, looks like dozens of individual fin edges
// without dozens of elements); the tube-end circles down the side are the
// U-bend cross-sections you'd see on a real coil face. Recolored gold per
// request — same metallic-gradient technique as the silver VS badge, just
// gold hues (#FFD700 / #B8860B / #FFF3B0) instead of silver/aluminium.
export const W = 640;
export const H = 560;

const COIL_X = 60;
const COIL_Y = 150;
const COIL_W = 520;
const COIL_H = 380;
const COIL_RX = 18;

const TUBE_CX = 108;
const TUBE_R = 32;
const TUBE_YS = [216, 320, 424];

// Deterministic hash — no Math.random(), so every render process/frame
// produces identical results (needed for reproducible video renders).
const hash = (i) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

export const FinCoil = ({ scale = 1, startFrame = 0, shadow = true }) => {
  const frame = useCurrentFrame();
  const lf = Math.max(0, frame - startFrame);

  // Slow glossy sweep across the fin face — reads as "still bright, clean
  // metal", not corroded. Loops continuously, no stagger/delay.
  const sweepPeriod = 140;
  const sweepT = (lf % sweepPeriod) / sweepPeriod;
  const sweepX = COIL_X - 220 + sweepT * (COIL_W + 440);

  return (
    <svg width={W * scale} height={H * scale} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        {/* Ribbed fin stripes — tiny repeating gradient cell, tiled across
            the whole coil face to fake many individual gold-plated fin edges. */}
        <pattern id="finStripes" width="12" height={COIL_H} patternUnits="userSpaceOnUse">
          <rect width="12" height={COIL_H} fill="#B8860B" />
          <rect width="12" height={COIL_H} fill="url(#finStripeGrad)" />
        </pattern>
        <linearGradient id="finStripeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#8B6914" stopOpacity="0.9" />
          <stop offset="18%" stopColor="#FFE066" stopOpacity="0.9" />
          <stop offset="50%" stopColor="#FFF3B0" stopOpacity="0.95" />
          <stop offset="82%" stopColor="#DAA520" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#8B6914" stopOpacity="0.9" />
        </linearGradient>

        <linearGradient id="coilEdgeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFF3B0" />
          <stop offset="100%" stopColor="#B8860B" />
        </linearGradient>

        <linearGradient id="tubeGrad" gradientUnits="userSpaceOnUse" x1={TUBE_CX - TUBE_R} y1="0" x2={TUBE_CX + TUBE_R} y2="0">
          <stop offset="0%" stopColor="#FFF3B0" />
          <stop offset="35%" stopColor="#FFD700" />
          <stop offset="70%" stopColor="#DAA520" />
          <stop offset="100%" stopColor="#8B6914" />
        </linearGradient>

        <clipPath id="coilClip">
          <rect x={COIL_X} y={COIL_Y} width={COIL_W} height={COIL_H} rx={COIL_RX} />
        </clipPath>

        <linearGradient id="sweepGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>

        <filter id="coilShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      {/* contact shadow, grounds the coil as a solid object — translucent
          blurred shapes don't key out cleanly over chroma-key green, so this
          is skipped there the same way Fan.jsx's ambient glow is (glow prop). */}
      {shadow && (
        <rect x={COIL_X + 10} y={COIL_Y + 18} width={COIL_W} height={COIL_H} rx={COIL_RX}
          fill="#001222" opacity="0.35" filter="url(#coilShadow)" />
      )}

      {/* fin stack face */}
      <rect x={COIL_X} y={COIL_Y} width={COIL_W} height={COIL_H} rx={COIL_RX} fill="url(#finStripes)" />

      {/* top edge highlight — reads as a lit metal rim */}
      <rect x={COIL_X} y={COIL_Y} width={COIL_W} height={14} rx={7} fill="url(#coilEdgeGrad)" opacity="0.8" />

      {/* glossy sweep, clipped to the coil silhouette */}
      <g clipPath="url(#coilClip)">
        <rect x={sweepX} y={COIL_Y} width="160" height={COIL_H} fill="url(#sweepGrad)" transform="skewX(-14)" />
      </g>

      {/* tube-end cross-sections (U-bends), overlapping the left edge of the fin face */}
      {TUBE_YS.map((cy, i) => (
        <g key={i}>
          {shadow && (
            <circle cx={TUBE_CX} cy={cy} r={TUBE_R} fill="#001222" opacity="0.3"
              transform={`translate(3 4)`} filter="url(#coilShadow)" />
          )}
          <circle cx={TUBE_CX} cy={cy} r={TUBE_R} fill="url(#tubeGrad)" />
          <circle cx={TUBE_CX - TUBE_R * 0.32} cy={cy - TUBE_R * 0.32} r={TUBE_R * 0.28} fill="#FFFFFF" opacity="0.45" />
        </g>
      ))}

      {/* frame outline for definition against the background */}
      <rect x={COIL_X} y={COIL_Y} width={COIL_W} height={COIL_H} rx={COIL_RX}
        fill="none" stroke="#FFF3B0" strokeOpacity="0.55" strokeWidth="2" />
    </svg>
  );
};

const PARTICLE_COUNT = 22;

// Salt mist — a nozzle at the top spraying a continuous cone of fine
// droplets down onto the coil below. Motion is a deterministic per-particle
// loop (no per-frame randomness), fading in/out across each cycle.
export const SaltMist = ({
  scale = 1,
  originX = W / 2,
  originY = 26,
  targetY = COIL_Y + 40,
  spread = 300,
  // Same on/off convention as FinCoil's shadow prop: true is the default,
  // soft-translucent look (safe when compositing over real footage later —
  // SaltSprayTestOverlay leaves this alone). Green-screen backdrops are a
  // solid flattened color, not real alpha, so partial per-particle opacity
  // there bakes visible backdrop color straight into the droplet pixels and
  // breaks chroma-keying — SaltSprayTestGreenScreen passes translucent=false
  // to force droplets fully opaque instead (snap on/off, no faded fill).
  translucent = true,
}) => {
  const frame = useCurrentFrame();

  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const h1 = hash(i);
    const h2 = hash(i + 100);
    const h3 = hash(i + 200);
    const h4 = hash(i + 300);
    const period = 46 + h1 * 44;
    const phaseFrames = h2 * period;
    const t = ((frame + phaseFrames) % period) / period;
    const dx = (h3 - 0.5) * spread * (0.5 + t * 0.5);
    const x = originX + dx;
    const y = originY + (targetY - originY) * t;
    const fade =
      t < 0.15 ? t / 0.15 : t > 0.78 ? Math.max(0, (1 - t) / 0.22) : 1;
    const clamped = Math.max(0, Math.min(1, fade));
    // Translucent pass keeps the soft per-particle fade in/out. Opaque pass
    // never lands on a partial alpha value — droplets are either fully
    // opaque or not drawn, so no backdrop color can blend through.
    const opacity = translucent ? clamped * 0.8 : clamped > 0.5 ? 1 : 0;
    const r = 2.2 + h4 * 3.2;
    return { key: i, x, y, r, opacity };
  });

  return (
    <svg
      width={W * scale}
      height={H * scale}
      viewBox={`0 0 ${W} ${H}`}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    >
      <defs>
        <radialGradient id="dropletGrad" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#BEE9F5" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#3FBFDD" stopOpacity="0.1" />
        </radialGradient>
        {/* Green-screen-safe droplet fill: same white/cyan hues, but every
            stop is fully opaque so the fill itself never relies on alpha
            blending — no low-opacity stop for a solid green backdrop to
            bleed through. */}
        <radialGradient id="dropletGradOpaque" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="55%" stopColor="#BEE9F5" stopOpacity="1" />
          <stop offset="100%" stopColor="#3FBFDD" stopOpacity="1" />
        </radialGradient>
        <linearGradient id="nozzleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F4F7FA" />
          <stop offset="40%" stopColor="#C8D4DF" />
          <stop offset="70%" stopColor="#9AAAB8" />
          <stop offset="100%" stopColor="#D0DAE4" />
        </linearGradient>
      </defs>

      {/* nozzle body */}
      <rect x={originX - 26} y={originY - 26} width="52" height="26" rx="8" fill="url(#nozzleGrad)" />
      <path
        d={`M ${originX - 20} ${originY} L ${originX + 20} ${originY} L ${originX + 7} ${originY + 22} L ${originX - 7} ${originY + 22} Z`}
        fill="url(#nozzleGrad)"
      />
      <circle cx={originX} cy={originY + 20} r="4.5" fill="#0074A2" />

      {particles.map((p) => (
        <circle
          key={p.key}
          cx={p.x}
          cy={p.y}
          r={p.r}
          fill={translucent ? 'url(#dropletGrad)' : 'url(#dropletGradOpaque)'}
          opacity={p.opacity}
        />
      ))}
    </svg>
  );
};

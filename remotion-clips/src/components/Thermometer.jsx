import { useCurrentFrame, interpolate, interpolateColors } from 'remotion';

const W = 140;
const H = 240;
const CX = 70;
const STEM_OUTER_W = 48;
const STEM_TOP_Y = 14;
const BULB_CY = 190;
const BULB_R_OUTER = 36;
const STEM_BOTTOM_Y = BULB_CY - BULB_R_OUTER * 0.35;
const GLASS_STROKE = 7;
const STEM_INNER_W = STEM_OUTER_W - GLASS_STROKE * 2;
const BULB_R_INNER = BULB_R_OUTER - GLASS_STROKE;
const INNER_TOP = STEM_TOP_Y + GLASS_STROKE;
const COLUMN_H = STEM_BOTTOM_Y - INNER_TOP;

const TICKS = [0, 1, 2, 3, 4, 5, 6].map((i) => STEM_TOP_Y + ((STEM_BOTTOM_Y - STEM_TOP_Y) * i) / 6);

// Mercury level: cools from a hot starting point down to a target, then either
// settles smoothly (inverter) or overshoots and cycles on/off (non-inverter) —
// same behavior TempLine already draws, applied to a fill height instead of a wave.
function useMercuryLevel(type, startFrame) {
  const frame = useCurrentFrame();
  const lf = Math.max(0, frame - startFrame);
  const isInverter = type === 'inverter';

  const fromLevel = 0.8;
  const targetLevel = 0.4;
  const dropProgress = interpolate(lf, [10, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  if (isInverter) {
    const settled = interpolate(lf, [38, 46], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const idle = Math.sin(lf * 0.05) * 0.015 * settled;
    const level = Math.max(0.08, Math.min(0.92, fromLevel - (fromLevel - targetLevel) * dropProgress + idle));
    return { level, colorT: dropProgress };
  }

  const cycleStart = 40;
  const period = 26;
  const cyclePhase = lf > cycleStart ? ((lf - cycleStart) % period) / period : 0;
  const bounce = lf > cycleStart ? Math.abs(Math.sin(cyclePhase * Math.PI)) * 0.12 : 0;
  const undershootTarget = targetLevel - 0.05;
  const level = Math.max(0.08, Math.min(0.92, fromLevel - (fromLevel - undershootTarget) * dropProgress + bounce));
  return { level, colorT: dropProgress };
}

export const Thermometer = ({ type = 'inverter', startFrame = 0, scale = 1, tempColor = false }) => {
  const { level, colorT } = useMercuryLevel(type, startFrame);
  const fillTopY = STEM_BOTTOM_Y - COLUMN_H * level;
  const gid = type === 'inverter' ? 'thermoInv' : 'thermoNonInv';

  // Brand rule is silver/cyan/white only (see feedback_design_system memory) — the
  // Inverter-vs-Non comparison series (TemperatureScene) must stay on that default.
  // `tempColor` is an explicit, scene-local exception for the standalone drop overlay,
  // where the user asked for a literal hot-red -> cool-blue mercury color.
  const mercuryStops = tempColor
    ? [
        interpolateColors(colorT, [0, 1], ['#FF8A65', '#8FE9F5']),
        interpolateColors(colorT, [0, 1], ['#F4511E', '#3FBFDD']),
        interpolateColors(colorT, [0, 1], ['#B71C1C', '#0074A2']),
      ]
    : ['#8FE9F5', '#3FBFDD', '#0074A2'];

  return (
    <svg width={W * scale} height={H * scale} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <linearGradient id={`${gid}Glass`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F4F7FA" />
          <stop offset="35%" stopColor="#C8D4DF" />
          <stop offset="70%" stopColor="#9AAAB8" />
          <stop offset="100%" stopColor="#D0DAE4" />
        </linearGradient>
        <linearGradient id={`${gid}Mercury`} gradientUnits="userSpaceOnUse" x1={CX} y1="0" x2={CX} y2={H}>
          <stop offset="0%" stopColor={mercuryStops[0]} />
          <stop offset="45%" stopColor={mercuryStops[1]} />
          <stop offset="100%" stopColor={mercuryStops[2]} />
        </linearGradient>
        <clipPath id={`${gid}Clip`}>
          <rect x="0" y={fillTopY} width={W} height={H - fillTopY} />
        </clipPath>
        {/* Ring mask: white = outer tube+bulb silhouette, black = inner hollow cut out of it.
            Drawing this as one masked fill (instead of stroking the rect and circle
            separately) avoids a seam where the stem's rounded corner would otherwise
            show up as a visible cut line inside the bulb. */}
        <mask id={`${gid}RingMask`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
          <rect x={CX - STEM_OUTER_W / 2} y={STEM_TOP_Y} width={STEM_OUTER_W} height={STEM_BOTTOM_Y - STEM_TOP_Y}
            rx={STEM_OUTER_W / 2} fill="#FFFFFF" />
          <circle cx={CX} cy={BULB_CY} r={BULB_R_OUTER} fill="#FFFFFF" />
          <rect x={CX - STEM_INNER_W / 2} y={INNER_TOP} width={STEM_INNER_W} height={STEM_BOTTOM_Y - INNER_TOP}
            rx={STEM_INNER_W / 2} fill="#000000" />
          <circle cx={CX} cy={BULB_CY} r={BULB_R_INNER} fill="#000000" />
        </mask>
      </defs>

      {/* faint glass fill so the empty tube still reads as glass, not a void */}
      <rect x={CX - STEM_INNER_W / 2} y={INNER_TOP} width={STEM_INNER_W} height={STEM_BOTTOM_Y - INNER_TOP}
        rx={STEM_INNER_W / 2} fill="#E8F4FA" opacity="0.55" />
      <circle cx={CX} cy={BULB_CY} r={BULB_R_INNER} fill="#E8F4FA" opacity="0.55" />

      {/* mercury, clipped to current level */}
      <g clipPath={`url(#${gid}Clip)`}>
        <rect x={CX - STEM_INNER_W / 2} y={INNER_TOP} width={STEM_INNER_W} height={STEM_BOTTOM_Y - INNER_TOP}
          rx={STEM_INNER_W / 2} fill={`url(#${gid}Mercury)`} />
        <circle cx={CX} cy={BULB_CY} r={BULB_R_INNER} fill={`url(#${gid}Mercury)`} />
      </g>

      {/* glass tube outline — one continuous seamless silhouette via mask, not two strokes */}
      <rect x="0" y="0" width={W} height={H} fill={`url(#${gid}Glass)`} mask={`url(#${gid}RingMask)`} />

      {/* glass shine */}
      <rect x={CX - STEM_INNER_W / 2 + 4} y={INNER_TOP + 6} width={4} height={STEM_BOTTOM_Y - INNER_TOP - 20}
        rx={2} fill="#FFFFFF" opacity="0.28" />

      {/* tick marks */}
      {TICKS.map((y, i) => (
        <line key={i} x1={CX + STEM_OUTER_W / 2 + 6} y1={y} x2={CX + STEM_OUTER_W / 2 + (i % 2 === 0 ? 16 : 11)} y2={y}
          stroke="#C8D4DF" strokeWidth="2.5" strokeLinecap="round" />
      ))}
    </svg>
  );
};

import { useCurrentFrame, interpolate } from 'remotion';

const W = 500;
const H = 100;
const POINTS = 80;

function inverterPath(frame) {
  const pts = [];
  for (let i = 0; i < POINTS; i++) {
    const t = i / POINTS;
    const x = t * W;
    // Smooth sine wave — variable speed
    const y = H / 2 - (H * 0.38) * (0.6 + 0.4 * Math.sin(t * Math.PI * 3 + frame * 0.04));
    pts.push(`${x},${y}`);
  }
  return 'M' + pts.join(' L');
}

function nonInverterPath(frame) {
  const pts = [];
  const period = 28; // frames per on/off cycle
  for (let i = 0; i < POINTS; i++) {
    const t = i / POINTS;
    const x = t * W;
    const cycle = Math.floor((t * POINTS + frame * 0.5) % period);
    const on = cycle < period * 0.55;
    const y = on ? H * 0.12 : H * 0.88;
    pts.push(`${x},${y}`);
  }
  return 'M' + pts.join(' L');
}

export const SpeedGraph = ({ type = 'inverter', width = W, height = H }) => {
  const frame = useCurrentFrame();

  const color = type === 'inverter' ? 'rgba(255,255,255,0.9)' : '#888';
  const drawProgress = interpolate(frame, [0, 40], [0, 1], { extrapolateRight: 'clamp' });

  const path = type === 'inverter' ? inverterPath(frame) : nonInverterPath(frame);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${W} ${H}`}>
      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map((y, i) => (
        <line key={i} x1="0" y1={y * H} x2={W} y2={y * H}
          stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      ))}

      {/* Graph line */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={W * 1.5}
        strokeDashoffset={W * 1.5 * (1 - drawProgress)}
        opacity="0.95"
      />

      {/* Area fill */}
      <path
        d={path + ` L${W},${H} L0,${H} Z`}
        fill={color}
        opacity={0.12 * drawProgress}
      />

      {/* Y axis */}
      <line x1="0" y1="0" x2="0" y2={H} stroke="rgba(255,255,255,0.2)" strokeWidth="1" />

      {/* Labels */}
      <text x="4" y="14" fill="rgba(255,255,255,0.5)" fontSize="11" fontFamily="sans-serif">MAX</text>
      <text x="4" y={H - 4} fill="rgba(255,255,255,0.5)" fontSize="11" fontFamily="sans-serif">OFF</text>
    </svg>
  );
};

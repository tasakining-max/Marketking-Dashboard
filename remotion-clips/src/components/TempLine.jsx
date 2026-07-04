import { useCurrentFrame, interpolate } from 'remotion';

const W = 500;
const H = 60;
const POINTS = 80;

export const TempLine = ({ type = 'inverter' }) => {
  const frame = useCurrentFrame();

  const drawProgress = interpolate(frame, [10, 50], [0, 1], { extrapolateRight: 'clamp' });

  const pts = [];
  for (let i = 0; i < POINTS; i++) {
    const t = i / POINTS;
    const x = t * W;
    let y;
    if (type === 'inverter') {
      // Very stable — slight gentle wave
      y = H * 0.5 + H * 0.08 * Math.sin(t * Math.PI * 2 + frame * 0.02);
    } else {
      // Bouncy — heats up and cools down repeatedly
      const period = 30;
      const phase = (t * POINTS + frame * 0.5) % period / period;
      y = H * 0.2 + H * 0.62 * Math.abs(Math.sin(phase * Math.PI));
    }
    pts.push(`${x},${y}`);
  }

  const path = 'M' + pts.join(' L');
  const color = type === 'inverter' ? 'rgba(255,255,255,0.9)' : '#F5F5F5';

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={W * 1.5}
        strokeDashoffset={W * 1.5 * (1 - drawProgress)}
        opacity="0.9"
      />
    </svg>
  );
};

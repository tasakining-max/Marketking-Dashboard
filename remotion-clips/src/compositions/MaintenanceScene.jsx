import { useCurrentFrame, interpolate } from 'remotion';
import { SceneBase } from '../components/SceneBase';
import { InfoPanel } from '../components/InfoPanel';

// High-tech spinning gear — specialist required
const TechGearIcon = () => {
  const frame = useCurrentFrame();
  const op    = interpolate(frame, [4, 20], [0, 1], { extrapolateRight: 'clamp' });
  const rot   = frame * 0.8;
  const cx = 100, cy = 60, r = 36;
  const teeth = 10;
  const outerR = r + 10;

  const gearPath = () => {
    let d = '';
    for (let i = 0; i < teeth * 2; i++) {
      const angle = (i * Math.PI) / teeth;
      const radius = i % 2 === 0 ? outerR : r;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      d += i === 0 ? `M${x},${y}` : `L${x},${y}`;
    }
    return d + 'Z';
  };

  return (
    <svg width={360} height={220} viewBox="0 0 200 120" opacity={op}>
      <g transform={`rotate(${rot}, ${cx}, ${cy})`}>
        <path d={gearPath()} fill="rgba(0,116,162,0.7)" stroke="#00C8E0" strokeWidth="1.5" />
        <circle cx={cx} cy={cy} r="16" fill="rgba(0,30,60,0.9)" stroke="#00C8E0" strokeWidth="1.5" />
      </g>
      {/* Circuit lines emanating from gear */}
      {[[150, 30], [155, 60], [148, 88]].map(([x, y], i) => (
        <g key={i} opacity={interpolate(frame, [15 + i * 5, 28 + i * 5], [0, 1], { extrapolateRight: 'clamp' })}>
          <line x1={cx + 38} y1={cy - 10 + i * 20} x2={x} y2={y} stroke="#00C8E0" strokeWidth="1.5" opacity="0.6" />
          <circle cx={x} cy={y} r="4" fill="#00C8E0" opacity="0.8" />
        </g>
      ))}
      <text x={cx + 40} y={cy + 30} fill="#00C8E0" fontSize="24" opacity={interpolate(frame, [30, 44], [0, 1], { extrapolateRight: 'clamp' })}>🔧</text>
    </svg>
  );
};

// Person holding a wrench
const PersonWithWrench = ({ cx, delay, frame, color }) => {
  const swing = Math.sin(frame * 0.1 + delay) * 12;
  const armEndX = cx + 18;
  const armEndY = 57;

  return (
    <g>
      {/* Head */}
      <circle cx={cx} cy="24" r="9" fill="none" stroke={color} strokeWidth="2.2" />
      {/* Body */}
      <line x1={cx} y1="33" x2={cx} y2="67" stroke={color} strokeWidth="2.2" />
      {/* Left arm */}
      <line x1={cx} y1="44" x2={cx - 15} y2="59" stroke={color} strokeWidth="2.2" />
      {/* Right arm */}
      <line x1={cx} y1="44" x2={armEndX} y2={armEndY} stroke={color} strokeWidth="2.2" />
      {/* Legs */}
      <line x1={cx} y1="67" x2={cx - 12} y2="91" stroke={color} strokeWidth="2.2" />
      <line x1={cx} y1="67" x2={cx + 12} y2="91" stroke={color} strokeWidth="2.2" />

      {/* Open-end wrench at right hand */}
      <g transform={`translate(${armEndX}, ${armEndY}) rotate(${38 + swing})`}>
        {/* Handle */}
        <rect x="-3" y="0" width="6" height="22" rx="2" fill="url(#silverWrench3)" />
        {/* Jaw base (neck) */}
        <rect x="-7" y="-3" width="14" height="5" rx="1.5" fill="url(#silverWrench3)" />
        {/* Left jaw prong */}
        <rect x="-7" y="-16" width="4" height="15" rx="1.5" fill="url(#silverWrench3)" />
        {/* Right jaw prong */}
        <rect x="3" y="-16" width="4" height="15" rx="1.5" fill="url(#silverWrench3)" />
        {/* Gap between prongs = bolt opening — left intentionally empty */}
      </g>
    </g>
  );
};

// Multiple people with wrenches
const WrenchIcon = () => {
  const frame = useCurrentFrame();
  const op    = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
  const col   = 'rgba(255,255,255,0.85)';

  return (
    <svg width={360} height={220} viewBox="0 0 200 110" opacity={op}>
      <defs>
        <linearGradient id="silverWrench3" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F1F0EE" />
          <stop offset="40%" stopColor="#C6C2BF" />
          <stop offset="70%" stopColor="#9A9693" />
          <stop offset="100%" stopColor="#D3D1CE" />
        </linearGradient>
      </defs>
      <PersonWithWrench cx={36}  delay={0}   frame={frame} color={col} />
      <PersonWithWrench cx={100} delay={1.2} frame={frame} color={col} />
      <PersonWithWrench cx={164} delay={2.4} frame={frame} color={col} />
    </svg>
  );
};

export const MaintenanceScene = () => (
  <SceneBase
    top={
      <InfoPanel
        type="inverter"
        mainText="ช่างเฉพาะทาง"
        subText={"เทคโนโลยีสูง\nแนะนำให้ดูแลพิเศษ"}
        icon={<TechGearIcon />}
        startFrame={0}
      />
    }
    bottom={
      <InfoPanel
        type="non-inverter"
        mainText="ซ่อมง่ายทั่วไป"
        subText={"ระบบเรียบง่าย\nหาช่างได้ทุกที่"}
        icon={<WrenchIcon />}
        startFrame={0}
      />
    }
  />
);

import { useCurrentFrame, interpolate } from 'remotion';
import { SceneBase } from '../components/SceneBase';
import { InfoPanel } from '../components/InfoPanel';

// Sun + Moon orbiting — runs all day and all night
const AllDayIcon = () => {
  const frame = useCurrentFrame();
  const op    = interpolate(frame, [4, 20], [0, 1], { extrapolateRight: 'clamp' });
  const angle = (frame * 1.5) % 360;
  const rad   = (angle * Math.PI) / 180;
  const cx = 100, cy = 60, r = 44;
  const sunX  = cx + r * Math.cos(rad);
  const sunY  = cy + r * Math.sin(rad);
  const moonX = cx + r * Math.cos(rad + Math.PI);
  const moonY = cy + r * Math.sin(rad + Math.PI);

  return (
    <svg width={360} height={250} viewBox="0 0 200 140" opacity={op}>
      {/* Orbit ring */}
      <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.38} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" />
      {/* Center circle (Earth / room) */}
      <circle cx={cx} cy={cy} r="18" fill="rgba(0,116,162,0.4)" stroke="#00C8E0" strokeWidth="2" />
      <text x={cx - 10} y={cy + 7} fontSize="16" fill="white">🏠</text>
      {/* Moon */}
      <circle cx={moonX} cy={moonY} r="10" fill="rgba(200,220,240,0.5)" />
      <text x={moonX - 9} y={moonY + 7} fontSize="14">🌙</text>
      {/* Sun */}
      <circle cx={sunX} cy={sunY} r="12" fill="rgba(255,210,50,0.3)" />
      <text x={sunX - 10} y={sunY + 8} fontSize="16">☀️</text>
      {/* Label */}
      <text x={cx - 16} y="136" fill="#00C8E0" fontSize="15" fontFamily="sans-serif" fontWeight="bold">24 hrs</text>
    </svg>
  );
};

// Partial clock — only 3-4 hours lit
const PartialClockIcon = () => {
  const frame = useCurrentFrame();
  const op      = interpolate(frame, [4, 20], [0, 1], { extrapolateRight: 'clamp' });
  const arcProg = interpolate(frame, [10, 36], [0, 1], { extrapolateRight: 'clamp' });

  const cx = 100, cy = 60, r = 46;
  // 3-4 hours = 90-120 degrees of a 360-degree clock
  const startAngle = -90 * (Math.PI / 180);
  const endAngle   = startAngle + (arcProg * 110 * Math.PI / 180);
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const largeArc = arcProg * 110 > 180 ? 1 : 0;

  return (
    <svg width={360} height={250} viewBox="0 0 200 140" opacity={op}>
      <defs>
        <linearGradient id="silverClock" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F4F7FA" />
          <stop offset="40%" stopColor="#C8D4DF" />
          <stop offset="75%" stopColor="#9AAAB8" />
          <stop offset="100%" stopColor="#D0DAE4" />
        </linearGradient>
      </defs>
      {/* Clock face */}
      <circle cx={cx} cy={cy} r={r} fill="rgba(20,30,45,0.7)" stroke="url(#silverClock)" strokeWidth="2.5" />
      {/* Tick marks */}
      {[0,1,2,3,4,5,6,7,8,9,10,11].map(i => {
        const a = (i * 30 - 90) * Math.PI / 180;
        const r1 = 38, r2 = 44;
        return <line key={i}
          x1={cx + r1 * Math.cos(a)} y1={cy + r1 * Math.sin(a)}
          x2={cx + r2 * Math.cos(a)} y2={cy + r2 * Math.sin(a)}
          stroke="rgba(200,215,232,0.6)" strokeWidth="1.5" />;
      })}
      {/* Active arc (3-4 hours portion) */}
      <path
        d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z`}
        fill="rgba(0,116,162,0.5)"
      />
      <path
        d={`M${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2}`}
        fill="none" stroke="url(#silverClock)" strokeWidth="3" strokeLinecap="round"
      />
      {/* Center dot */}
      <circle cx={cx} cy={cy} r="5" fill="url(#silverClock)" />
      {/* Label */}
      <text x={cx - 20} y="136" fill="url(#silverClock)" fontSize="15" fontFamily="sans-serif" fontWeight="bold">3-4 hrs</text>
    </svg>
  );
};

export const RoomScene = () => (
  <SceneBase
    top={
      <InfoPanel
        type="inverter"
        mainText="เปิดทั้งวัน"
        subText={"หรือเปิดตลอดคืน\nยิ่งใช้นาน ยิ่งคุ้ม"}
        icon={<AllDayIcon />}
        startFrame={0}
      />
    }
    bottom={
      <InfoPanel
        type="non-inverter"
        mainText="วันละ 3-4 ชั่วโมง"
        subText={"ใช้ไม่นาน ก็ประหยัดได้\nไม่ต้องลงทุนสูง"}
        icon={<PartialClockIcon />}
        startFrame={0}
      />
    }
  />
);

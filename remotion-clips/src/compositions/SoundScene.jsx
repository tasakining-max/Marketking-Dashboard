import { useCurrentFrame, interpolate } from 'remotion';
import { SceneBase } from '../components/SceneBase';
import { InfoPanel } from '../components/InfoPanel';

// Gentle continuous wave — inverter runs smoothly and quietly
const QuietWaveIcon = () => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [4, 20], [0, 1], { extrapolateRight: 'clamp' });

  const wave = (yBase, amp, speed, offset) => {
    const pts = [];
    for (let x = 0; x <= 200; x += 4) {
      const y = yBase + amp * Math.sin((x * 0.05) + frame * speed + offset);
      pts.push(`${x},${y}`);
    }
    return 'M' + pts.join(' L');
  };

  return (
    <svg width={360} height={220} viewBox="0 0 200 120" opacity={op}>
      {/* Speaker */}
      <rect x="10" y="42" width="20" height="36" rx="3" fill="#00C8E0" opacity="0.7" />
      <path d="M30,38 L50,24 L50,96 L30,82 Z" fill="#00C8E0" opacity="0.7" />
      {/* Gentle waves — small amplitude */}
      <path d={wave(60, 6, 0.06, 0)} fill="none" stroke="#00C8E0" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      <path d={wave(60, 6, 0.06, 1.2)} fill="none" stroke="#00C8E0" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
      <path d={wave(60, 6, 0.06, 2.4)} fill="none" stroke="#00C8E0" strokeWidth="1.5" strokeLinecap="round" opacity="0.25" />
    </svg>
  );
};

// Periodic burst — non-inverter is loud when starting
const BurstWaveIcon = () => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [4, 20], [0, 1], { extrapolateRight: 'clamp' });

  const period = 50;
  const phase  = (frame % period) / period;
  const burst  = phase < 0.45 ? Math.sin(phase * Math.PI / 0.45) : 0;
  const amp    = 8 + 28 * burst;

  const wave = (yBase, ampMult, offset) => {
    const pts = [];
    for (let x = 0; x <= 200; x += 4) {
      const y = yBase + amp * ampMult * Math.sin((x * 0.05) + frame * 0.12 + offset);
      pts.push(`${x},${y}`);
    }
    return 'M' + pts.join(' L');
  };

  return (
    <svg width={360} height={220} viewBox="0 0 200 120" opacity={op}>
      <defs>
        <linearGradient id="silverBurst" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F4F7FA" />
          <stop offset="40%" stopColor="#C8D4DF" />
          <stop offset="75%" stopColor="#9AAAB8" />
          <stop offset="100%" stopColor="#D0DAE4" />
        </linearGradient>
      </defs>
      <rect x="10" y="42" width="20" height="36" rx="3" fill="url(#silverBurst)" opacity="0.95" />
      <path d="M30,38 L50,24 L50,96 L30,82 Z" fill="url(#silverBurst)" opacity="0.95" />
      <path d={wave(60, 1, 0)} fill="none" stroke="url(#silverBurst)" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      <path d={wave(60, 1, 1.2)} fill="none" stroke="url(#silverBurst)" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
      <path d={wave(60, 1, 2.4)} fill="none" stroke="url(#silverBurst)" strokeWidth="1.5" strokeLinecap="round" opacity="0.25" />
    </svg>
  );
};

export const SoundScene = () => (
  <SceneBase
    top={
      <InfoPanel
        type="inverter"
        mainText="เงียบกว่า"
        subText={"ทำงานต่อเนื่อง\nนุ่มนวล ไม่รบกวน"}
        icon={<QuietWaveIcon />}
        startFrame={0}
      />
    }
    bottom={
      <InfoPanel
        type="non-inverter"
        mainText="ได้ยินตอนสตาร์ท"
        subText={"เสียงมอเตอร์\nเมื่อเริ่มทำงานเต็มกำลัง"}
        icon={<BurstWaveIcon />}
        startFrame={0}
      />
    }
  />
);

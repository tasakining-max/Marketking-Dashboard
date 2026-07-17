import { AbsoluteFill } from 'remotion';
import { FinCoil, SaltMist, W as COIL_W, H as COIL_H } from '../components/FinCoil';
import { StageBadge, STAGES } from '../components/StageBadge';

const SCALE = 1.6;

// Transparent overlay — the gold fin coil being salt-spray tested, plus the
// 1000/2000/3000hr stage progression badges, composited directly on top so
// this can drop straight onto other footage. No closing headline (removed
// per explicit request) — just the coil, mist, and stage badges. Deliberately
// breaking from the plain no-text loop convention used by the other
// Overlay/GreenScreen pairs here — explicit user choice for this pair.
// Render with an alpha-capable codec (webm/vp8 or prores4444), not plain
// h264 mp4, or the transparency will be flattened to black.
export const SaltSprayTestOverlay = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
    <div style={{ position: 'relative', width: COIL_W * SCALE, height: COIL_H * SCALE }}>
      <FinCoil scale={SCALE} startFrame={0} />
      <SaltMist scale={SCALE} />
    </div>

    <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 60 }}>
      {STAGES.map((s) => (
        <StageBadge key={s.hours} hours={s.hours} activateFrame={s.activateFrame} />
      ))}
    </div>
  </AbsoluteFill>
);

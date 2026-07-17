import { AbsoluteFill } from 'remotion';
import { FinCoil, SaltMist, W as COIL_W, H as COIL_H } from '../components/FinCoil';
import { StageBadge, STAGES } from '../components/StageBadge';

const SCALE = 1.6;

// Same content as SaltSprayTestOverlay (gold fin coil + salt mist + the
// 1000/2000/3000hr stage badges, no closing headline), but on a solid
// chroma-key green background instead of true alpha transparency — see
// TemperatureDropGreenScreen for why: alpha-channel formats (webm/prores)
// are unreliable across editors, and a flat #00FF00 h264 mp4 works
// everywhere, including CapCut's chroma key.
// shadow=false drops FinCoil's translucent blurred contact shadows, which
// otherwise leave a dark halo baked into the green instead of keying out
// cleanly — same reasoning as Fan.jsx's glow={false} on its green-screen pass.
// translucent=false does the same for the mist droplets: partial per-particle
// alpha over a solid green backdrop bakes visible green into the droplets
// (read as a green tint) instead of compositing correctly, so this forces
// droplets fully opaque white/cyan with no low-alpha fill relied on.
export const SaltSprayTestGreenScreen = () => (
  <AbsoluteFill style={{
    alignItems: 'center', justifyContent: 'center', flexDirection: 'column', backgroundColor: '#00FF00',
  }}>
    <div style={{ position: 'relative', width: COIL_W * SCALE, height: COIL_H * SCALE }}>
      <FinCoil scale={SCALE} startFrame={0} shadow={false} />
      <SaltMist scale={SCALE} translucent={false} />
    </div>

    <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 60 }}>
      {STAGES.map((s) => (
        <StageBadge key={s.hours} hours={s.hours} activateFrame={s.activateFrame} />
      ))}
    </div>
  </AbsoluteFill>
);

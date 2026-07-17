import { AbsoluteFill } from 'remotion';
import { Fan } from '../components/Fan';

// Transparent overlay — just the spinning fan blades. No text, no panel
// background — meant to be composited over other footage. Render with an
// alpha-capable codec (webm/vp8 or prores4444), not plain h264 mp4, or the
// transparency will be flattened to black.
export const FanSwingOverlay = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
    <Fan startFrame={0} scale={3} />
  </AbsoluteFill>
);

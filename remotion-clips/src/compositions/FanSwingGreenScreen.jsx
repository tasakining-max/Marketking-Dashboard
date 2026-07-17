import { AbsoluteFill } from 'remotion';
import { Fan } from '../components/Fan';

// Same animation as FanSwingOverlay, but on a solid chroma-key green
// background instead of true alpha transparency — see TemperatureDropGreenScreen
// for why: alpha-channel formats (webm/prores) are unreliable across editors,
// and a flat #00FF00 h264 mp4 works everywhere, including CapCut's chroma key.
export const FanSwingGreenScreen = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', backgroundColor: '#00FF00' }}>
    <Fan startFrame={0} scale={3} glow={false} />
  </AbsoluteFill>
);

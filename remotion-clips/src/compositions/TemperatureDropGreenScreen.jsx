import { AbsoluteFill } from 'remotion';
import { Thermometer } from '../components/Thermometer';

// Same animation as TemperatureDropOverlay, but on a solid chroma-key green
// background instead of true alpha transparency. Alpha channels (webm/prores)
// are unreliable across editors — CapCut in particular doesn't open webm and
// needs a real image to run its AI background removal / chroma key on. Plain
// h264 mp4 with a flat #00FF00 background works everywhere.
export const TemperatureDropGreenScreen = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', backgroundColor: '#00FF00' }}>
    <Thermometer type="inverter" startFrame={0} scale={3.4} tempColor />
  </AbsoluteFill>
);

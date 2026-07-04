import {
  AbsoluteFill, useCurrentFrame, interpolate, spring,
  useVideoConfig,
} from 'remotion';
import { SilverDivider } from './SilverDivider';

const FONT = 'Frutiger, sans-serif';

export const SceneBase = ({ top, bottom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 4], [0, 1], { extrapolateRight: 'clamp' });

  const dividerW    = interpolate(frame, [0, 8], [0, 100], { extrapolateRight: 'clamp' });
  const dividerGlow = 0.5 + 0.4 * Math.sin(frame * 0.08);

  const vsSp       = spring({ frame: Math.max(0, frame - 4), fps, config: { damping: 10, stiffness: 300, mass: 0.5 } });
  const vsScale    = interpolate(vsSp, [0, 1], [0, 1]);
  const ringScale  = 1 + 0.1 * Math.sin(frame * 0.09);
  const ringOpacity= 0.3 + 0.2 * Math.sin(frame * 0.09);

  return (
    <AbsoluteFill style={{ opacity: fadeIn, background: '#001020' }}>


      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '50%', zIndex: 2 }}>
        {top}
      </div>

      <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '50%', zIndex: 2 }}>
        {bottom}
      </div>

      <SilverDivider />

      {/* VS Badge */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: `translate(-50%, -50%) scale(${vsScale})`,
        zIndex: 10,
      }}>
        <div style={{
          position: 'absolute', inset: -18, borderRadius: '50%',
          border: '1.5px solid rgba(0,200,224,0.5)',
          transform: `scale(${ringScale})`, opacity: ringOpacity,
        }} />
        <div style={{
          position: 'absolute', inset: -8, borderRadius: '50%',
          border: '1px solid rgba(255,255,255,0.2)',
          transform: `scale(${1 + (1 - ringScale) * 0.5})`, opacity: ringOpacity * 0.6,
        }} />
        <div style={{
          width: 120, height: 120, borderRadius: '50%',
          background: 'linear-gradient(145deg, #F1F0EE 0%, #C6C2BF 40%, #9A9693 70%, #D3D1CE 100%)',
          border: '3px solid rgba(254,253,252,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 48px rgba(206,202,198,0.6)',
        }}>
          <span style={{ color: '#001222', fontSize: 42, fontWeight: 900, fontFamily: FONT, letterSpacing: -1 }}>
            VS
          </span>
        </div>
      </div>

    </AbsoluteFill>
  );
};

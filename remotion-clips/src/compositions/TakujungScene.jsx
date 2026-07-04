import {
  AbsoluteFill, useCurrentFrame, interpolate, spring,
  useVideoConfig, Img, staticFile,
} from 'remotion';
import { loadFrutiger } from '../utils/fonts';

loadFrutiger();

const FONT = 'Frutiger, sans-serif';
const CHANG = staticFile('takujung/ทาคุจัง ช่าง.png');

export const TakujungScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Entry spring — bounce up from below
  const entrySpring = spring({ frame, fps, config: { damping: 14, stiffness: 160 } });
  const entryY = interpolate(entrySpring, [0, 1], [700, 0]);

  const fadeIn = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });

  // Talking body bob — fast rhythm
  const bob   = Math.sin(frame * 0.18) * 10;
  // Squash & stretch on the bob cycle
  const scaleY = 1 + Math.sin(frame * 0.18) * 0.025;
  const scaleX = 1 - Math.sin(frame * 0.18) * 0.012;
  // Gentle sway
  const sway  = Math.sin(frame * 0.09) * 2.5;

  // Ground shadow reacts to sway
  const shadowX = sway * 4;

  // Ambient glow pulse
  const glow = 0.28 + 0.12 * Math.sin(frame * 0.06);

  return (
    <AbsoluteFill style={{
      opacity: fadeIn,
      background: 'radial-gradient(ellipse at 40% 20%, rgba(255,255,255,0.06) 0%, transparent 55%), linear-gradient(160deg, #0082B4 0%, #004570 60%, #002840 100%)',
    }}>
      {/* Ambient glow */}
      <div style={{
        position: 'absolute',
        bottom: '8%',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 680,
        height: 860,
        borderRadius: '50%',
        background: `radial-gradient(ellipse, rgba(0,150,210,${glow}) 0%, transparent 65%)`,
        filter: 'blur(70px)',
        pointerEvents: 'none',
      }} />
      {/* Ground shadow */}
      <div style={{
        position: 'absolute',
        bottom: 48,
        left: '50%',
        transform: `translateX(calc(-50% + ${shadowX}px))`,
        width: 460,
        height: 70,
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.32)',
        filter: 'blur(38px)',
        pointerEvents: 'none',
      }} />
      {/* Text — เชื่อใจ TASAKI */}
      <div style={{
        position: 'absolute',
        top: 360,
        left: 0,
        right: 0,
        textAlign: 'center',
        zIndex: 10,
        opacity: interpolate(frame, [8, 18], [0, 1], { extrapolateRight: 'clamp' }),
        transform: `translateY(${bob * 0.4}px)`,
      }}>
        <div style={{
          color: 'rgba(255,255,255,0.95)',
          fontSize: 96,
          fontFamily: FONT,
          fontWeight: 700,
          letterSpacing: 4,
          lineHeight: 1.2,
          textShadow: '0 0 40px rgba(0,180,255,0.5), 0 4px 20px rgba(0,0,0,0.4)',
        }}>
          เชื่อใจ
        </div>
        <div style={{
          color: '#F1F0EE',
          fontSize: 112,
          fontFamily: FONT,
          fontWeight: 900,
          letterSpacing: 16,
          lineHeight: 1.1,
          background: 'linear-gradient(145deg, #F1F0EE 0%, #C6C2BF 40%, #9A9693 70%, #D3D1CE 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))',
        }}>
          TASAKI
        </div>
      </div>

      {/* Character */}
      <div style={{
        position: 'absolute',
        bottom: 120,
        left: '50%',
        width: '65%',
        transform: `
          translateX(-50%)
          translateY(${entryY + bob}px)
          rotate(${sway}deg)
          scaleX(${scaleX})
          scaleY(${scaleY})
        `,
        transformOrigin: '50% 100%',
      }}>
        <Img
          src={CHANG}
          style={{
            width: '100%',
            objectFit: 'contain',
            display: 'block',
            filter: `drop-shadow(${shadowX * 0.2}px 20px 44px rgba(0,0,0,0.45))`,
          }}
        />
      </div>
      {/* Logo */}
      <Img
        src={staticFile('corner silver logo.png')}
        style={{
          position: 'absolute',
          top: -10,
          left: -20,
          width: 1080,
          objectFit: 'contain',
          zIndex: 20,
          filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))',
        }} />
    </AbsoluteFill>
  );
};

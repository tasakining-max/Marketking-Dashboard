import { useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import { loadFrutiger } from '../utils/fonts';

loadFrutiger();

const FONT = 'Frutiger, sans-serif';

export const InfoPanel = ({ type, mainText, subText, icon, startFrame = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lf = Math.max(0, frame - startFrame);
  const isInverter = type === 'inverter';

  // Everything snaps in together — no stagger
  const panelOp    = interpolate(lf, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
  const panelScale = interpolate(lf, [0, 6], [0.96, 1], { extrapolateRight: 'clamp' });

  const labelOp = panelOp;
  const iconOp = panelOp;
  const iconScale = panelScale;
  const textOp = panelOp;
  const textY = 0;

  const accent = isInverter ? '#00C8E0' : '#D6DEE8';
  const bg     = isInverter
    ? 'radial-gradient(ellipse at 25% 20%, rgba(255,255,255,0.06) 0%, transparent 55%), linear-gradient(160deg, #0082B4 0%, #004570 100%)'
    : 'radial-gradient(ellipse at 75% 15%, rgba(255,255,255,0.03) 0%, transparent 50%), linear-gradient(160deg, #0C1318 0%, #16202E 50%, #1E2A3C 80%, #080D14 100%)';

  return (
    <div style={{
      width: '100%', height: '100%',
      background: bg,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'space-evenly',
      padding: '44px 64px',
      position: 'relative', overflow: 'hidden',
    }}>

      {/* Radial glow accent */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: isInverter
          ? 'radial-gradient(ellipse at 20% 80%, rgba(0,116,162,0.4) 0%, transparent 60%)'
          : 'radial-gradient(ellipse at 80% 20%, rgba(180,195,215,0.12) 0%, transparent 55%)',
      }} />

      {/* Silver shimmer line — non-inverter only */}
      {!isInverter && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(210,220,235,0.6), transparent)',
          boxShadow: '0 0 16px rgba(210,220,235,0.3)',
        }} />
      )}

      {/* Label */}
      <div style={{
        opacity: labelOp, alignSelf: 'flex-start',
        display: 'flex', alignItems: 'center', gap: 12, position: 'relative',
      }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: accent, boxShadow: `0 0 14px ${accent}`,
        }} />
        <span style={{
          color: accent, fontSize: 30, fontFamily: FONT,
          fontWeight: 700, letterSpacing: 4,
        }}>
          {isInverter ? 'INVERTER' : 'NON-INVERTER'}
        </span>
      </div>

      {/* Icon */}
      <div style={{
        opacity: iconOp,
        transform: `scale(${iconScale})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative',
      }}>
        {icon}
      </div>

      {/* Text */}
      <div style={{
        opacity: textOp,
        transform: `translateY(${textY}px)`,
        textAlign: 'center', position: 'relative',
      }}>
        <div style={{
          color: '#FFFFFF', fontSize: 84, fontFamily: FONT,
          fontWeight: 700, lineHeight: 1.15, letterSpacing: -1,
        }}>
          {mainText}
        </div>
        <div style={{
          color: accent, fontSize: 40, fontFamily: FONT,
          fontWeight: 400, marginTop: 14, lineHeight: 1.4,
        }}>
          {subText}
        </div>
      </div>

    </div>
  );
};

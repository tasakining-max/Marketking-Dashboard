import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

const SILVER_GRAD = 'linear-gradient(145deg, #F4F7FA 0%, #C8D4DF 40%, #9AAAB8 70%, #D0DAE4 100%)';
const FONT = 'Frutiger, sans-serif';

// Salt Spray Test stage progression — 1000 / 2000 / 3000 hours, each badge
// snapping in (spring, stiffness 200+, starts at its own activateFrame, no
// stagger/delay beyond that single trigger point) and getting a checkmark
// once it's held for a beat, reinforcing "no corrosion at this stage".
export const STAGES = [
  { hours: 1000, activateFrame: 24 },
  { hours: 2000, activateFrame: 150 },
  { hours: 3000, activateFrame: 264 },
];

export const StageBadge = ({ hours, activateFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Signed distance to this badge's own trigger point — deliberately NOT
  // clamped to 0 before use, so a badge whose activateFrame hasn't arrived
  // yet (e.g. 2000/3000 while frame is still in the 1000 window) resolves to
  // a negative value here and gets clamped to fully-hidden below, instead of
  // silently reading as "frame 0 of its own animation" and popping in early.
  const signedLocal = frame - activateFrame;
  const clampedLocal = Math.max(0, signedLocal);

  // Fully hidden until activateFrame, then a fast 0-8 frame snap-in — no
  // dim "upcoming" placeholder state, so nothing is visible/legible ahead of
  // its turn in the 1000 -> 2000 -> 3000 sequence.
  const opacity = interpolate(signedLocal, [0, 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const s = spring({ frame: clampedLocal, fps, config: { damping: 13, stiffness: 220, mass: 0.6 } });
  const scale = interpolate(s, [0, 1], [0.7, 1]);
  const checkOpacity = interpolate(signedLocal, [16, 24], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{
      width: 300,
      height: 130,
      borderRadius: 65,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      opacity,
      transform: `scale(${scale})`,
      background: SILVER_GRAD,
      border: '3px solid rgba(255,255,255,0.7)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    }}>
      <div style={{
        fontFamily: FONT,
        fontWeight: 900,
        fontSize: 48,
        lineHeight: 1,
        color: '#001222',
      }}>
        {hours.toLocaleString()}
      </div>
      <div style={{
        fontFamily: FONT,
        fontWeight: 700,
        fontSize: 30,
        marginTop: 2,
        color: '#0074A2',
      }}>
        ชั่วโมง
      </div>

      <div style={{
        position: 'absolute',
        top: -14,
        right: -14,
        width: 44,
        height: 44,
        borderRadius: '50%',
        background: '#0074A2',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: checkOpacity,
        transform: `scale(${checkOpacity})`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24">
          <path d="M4 12.5 L9.5 18 L20 6" fill="none" stroke="#FFFFFF" strokeWidth="3.4"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
};

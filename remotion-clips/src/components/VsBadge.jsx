import { useCurrentFrame, spring, interpolate, useVideoConfig } from 'remotion';

export const VsBadge = ({ startFrame = 40 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = Math.max(0, frame - startFrame);

  const s = spring({ frame: localFrame, fps, config: { damping: 10, stiffness: 200, mass: 0.6 } });
  const scale = interpolate(s, [0, 1], [0, 1]);
  const opacity = interpolate(localFrame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });

  // Pulse ช้าๆ หลัง pop
  const pulse = interpolate(
    Math.sin((frame - startFrame - 20) * 0.08),
    [-1, 1],
    [0.97, 1.03]
  );
  const finalScale = localFrame > 20 ? scale * pulse : scale;

  return (
    <div style={{
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: `translate(-50%, -50%) scale(${finalScale})`,
      opacity,
      zIndex: 10,
    }}>
      <div style={{
        width: 80,
        height: 80,
        borderRadius: '50%',
        background: '#001F33',
        border: '3px solid #FFFFFF',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      }}>
        <span style={{
          color: '#FFFFFF',
          fontSize: 28,
          fontWeight: 900,
          fontFamily: 'sans-serif',
          letterSpacing: -1,
        }}>VS</span>
      </div>
    </div>
  );
};

import { useCurrentFrame, interpolate, spring, useVideoConfig, Img } from 'remotion';

export const SplitHalf = ({
  bg,
  dicut,
  slideFrom = 'top',
  startFrame = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = Math.max(0, frame - startFrame);

  // BG slide in
  const slideY = interpolate(localFrame, [0, 20], [slideFrom === 'top' ? -80 : 80, 0], {
    extrapolateRight: 'clamp',
  });

  // BG Ken Burns zoom
  const bgScale = interpolate(frame, [0, 150], [1, 1.06]);

  // Die-cut spring pop
  const dicutSpring = spring({ frame: localFrame - 10, fps, config: { damping: 14, stiffness: 120 } });
  const dicutScale = interpolate(dicutSpring, [0, 1], [0.85, 1]);
  const dicutOpacity = interpolate(localFrame, [10, 25], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>

      {/* Background */}
      <div style={{ position: 'absolute', inset: 0, transform: `translateY(${slideY}px)` }}>
        {bg ? (
          <Img
            src={bg}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `scale(${bgScale})`,
              transformOrigin: 'center center',
            }}
          />
        ) : (
          // Placeholder gradient ถ้ายังไม่มีรูป
          <div style={{
            width: '100%',
            height: '100%',
            background: slideFrom === 'top'
              ? 'linear-gradient(135deg, #001F33 0%, #003A5C 100%)'
              : 'linear-gradient(135deg, #0074A2 0%, #005A82 100%)',
          }} />
        )}
      </div>

      {/* Die-cut product */}
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${dicutScale})`,
        opacity: dicutOpacity,
      }}>
        {dicut ? (
          <Img
            src={dicut}
            style={{
              width: '85%',
              objectFit: 'contain',
              filter: 'drop-shadow(0px 12px 24px rgba(0,0,0,0.35))',
            }}
          />
        ) : (
          // Placeholder box
          <div style={{
            width: '80%',
            height: '40%',
            border: '3px dashed rgba(255,255,255,0.3)',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 28,
            fontFamily: 'sans-serif',
          }}>
            {slideFrom === 'top' ? '[ Inverter Die-cut ]' : '[ Non-Inverter Die-cut ]'}
          </div>
        )}
      </div>
    </div>
  );
};

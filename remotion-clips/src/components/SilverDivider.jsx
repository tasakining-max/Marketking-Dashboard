import { useCurrentFrame } from 'remotion';

export const SilverDivider = () => {
  const frame = useCurrentFrame();
  const glow = 0.55 + 0.35 * Math.sin(frame * 0.07);

  return (
    <div style={{
      position: 'absolute',
      top: '50%',
      left: 0,
      right: 0,
      height: 3,
      background: 'linear-gradient(90deg, transparent 0%, #CCCAC8 20%, #ECEAEA 50%, #CCCAC8 80%, transparent 100%)',
      boxShadow: `0 0 24px rgba(206,202,198,0.9), 0 0 48px rgba(184,180,176,0.5)`,
      transform: 'translateY(-50%)',
      zIndex: 6,
      opacity: glow,
    }} />
  );
};

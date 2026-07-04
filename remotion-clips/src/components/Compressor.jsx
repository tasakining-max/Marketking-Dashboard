import { useCurrentFrame, interpolate } from 'remotion';

export const Compressor = ({ rpm = 1, color = '#0074A2', size = 160 }) => {
  const frame = useCurrentFrame();
  const rotation = (frame * rpm * 6) % 360;

  return (
    <svg width={size} height={size} viewBox="0 0 160 160">
      {/* Outer ring */}
      <circle cx="80" cy="80" r="74" fill="none" stroke={color} strokeWidth="6" opacity="0.2" />
      <circle cx="80" cy="80" r="74" fill="none" stroke={color} strokeWidth="2" opacity="0.5"
        strokeDasharray="12 8" />

      {/* Spinning rotor */}
      <g transform={`rotate(${rotation}, 80, 80)`}>
        {[0, 60, 120, 180, 240, 300].map((angle, i) => (
          <g key={i} transform={`rotate(${angle}, 80, 80)`}>
            <rect x="76" y="20" width="8" height="32" rx="4"
              fill={color} opacity={0.7 + 0.3 * Math.sin(i)} />
          </g>
        ))}
        {/* Center hub */}
        <circle cx="80" cy="80" r="18" fill={color} opacity="0.9" />
        <circle cx="80" cy="80" r="10" fill="white" opacity="0.3" />
      </g>

      {/* Glow pulse */}
      <circle cx="80" cy="80" r="74"
        fill="none"
        stroke={color}
        strokeWidth="4"
        opacity={0.15 * (1 + Math.sin(frame * 0.15))}
      />
    </svg>
  );
};

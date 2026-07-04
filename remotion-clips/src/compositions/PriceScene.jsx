import { useCurrentFrame, interpolate } from 'remotion';
import { SceneBase } from '../components/SceneBase';
import { InfoPanel } from '../components/InfoPanel';

// Animated bar chart — investment grows over time
const InvestIcon = () => {
  const frame = useCurrentFrame();
  const b1 = interpolate(frame, [5, 22], [0, 55], { extrapolateRight: 'clamp' });
  const b2 = interpolate(frame, [10, 27], [0, 90], { extrapolateRight: 'clamp' });
  const b3 = interpolate(frame, [15, 32], [0, 130], { extrapolateRight: 'clamp' });
  const arrowOp = interpolate(frame, [28, 42], [0, 1], { extrapolateRight: 'clamp' });
  const boltOp  = interpolate(frame, [36, 50], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <svg width={200} height={160} viewBox="0 0 200 160">
      <defs>
        <linearGradient id="barGrad1" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#A8D8F0" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id="barGrad2" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#C0E4F8" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="barGrad3" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#D8F0FF" stopOpacity="0.8" />
        </linearGradient>
      </defs>
      <rect x="16" y={145 - b1} width="42" height={b1} rx="5" fill="url(#barGrad1)" />
      <rect x="79" y={145 - b2} width="42" height={b2} rx="5" fill="url(#barGrad2)" />
      <rect x="142" y={145 - b3} width="42" height={b3} rx="5" fill="url(#barGrad3)" />
      <line x1="0" y1="148" x2="200" y2="148" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" />
      <polyline
        points={`30,138 100,70 165,18`}
        fill="none" stroke="#00C8E0" strokeWidth="3"
        strokeLinecap="round" strokeLinejoin="round"
        opacity={arrowOp}
      />
      <polygon points="165,8 176,26 152,22" fill="#00C8E0" opacity={arrowOp} />
      <text x="152" y="52" fill="#FFD700" fontSize="30" opacity={boltOp}>⚡</text>
    </svg>
  );
};

// Coin stack — accessible price
const CoinIcon = () => {
  const frame = useCurrentFrame();
  const op1 = interpolate(frame, [5, 18], [0, 1], { extrapolateRight: 'clamp' });
  const op2 = interpolate(frame, [10, 22], [0, 1], { extrapolateRight: 'clamp' });
  const op3 = interpolate(frame, [15, 26], [0, 1], { extrapolateRight: 'clamp' });
  const tagOp = interpolate(frame, [22, 36], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <svg width={200} height={160} viewBox="0 0 200 160">
      <defs>
        <linearGradient id="silverCoin" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F4F7FA" />
          <stop offset="35%" stopColor="#C8D4DF" />
          <stop offset="70%" stopColor="#9AAAB8" />
          <stop offset="100%" stopColor="#D0DAE4" />
        </linearGradient>
        <linearGradient id="silverCoinDim" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#C8D4DF" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#8090A0" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      <ellipse cx="80" cy="145" rx="55" ry="14" fill="url(#silverCoinDim)" opacity={op1} />
      <rect x="25" y="108" width="110" height="37" rx="6" fill="url(#silverCoinDim)" opacity={op1} />
      <ellipse cx="80" cy="108" rx="55" ry="14" fill="url(#silverCoinDim)" opacity={op1} />

      <rect x="25" y="72" width="110" height="36" rx="6" fill="url(#silverCoin)" opacity={op2 * 0.7} />
      <ellipse cx="80" cy="72" rx="55" ry="14" fill="url(#silverCoin)" opacity={op2 * 0.8} />

      <rect x="25" y="36" width="110" height="36" rx="6" fill="url(#silverCoin)" opacity={op3 * 0.9} />
      <ellipse cx="80" cy="36" rx="55" ry="14" fill="url(#silverCoin)" opacity={op3} />
      <text x="60" y="42" fill="white" fontSize="20" fontWeight="bold" fontFamily="sans-serif" opacity={op3}>฿</text>

      {/* Price tag */}
      <path d="M145,20 L188,20 L188,68 L166,90 L145,68 Z"
        stroke="url(#silverCoin)" strokeWidth="2.5" fill="rgba(180,195,215,0.15)" opacity={tagOp} />
      <circle cx="158" cy="35" r="6" fill="url(#silverCoin)" opacity={tagOp} />
    </svg>
  );
};

export const PriceScene = () => (
  <SceneBase
    top={
      <InfoPanel
        type="inverter"
        mainText="ลงทุนสูงกว่า"
        subText={"แต่ค่าไฟถูกลง\nในระยะยาว"}
        icon={<InvestIcon />}
        startFrame={0}
      />
    }
    bottom={
      <InfoPanel
        type="non-inverter"
        mainText="ราคาเข้าถึงง่าย"
        subText="ติดตั้งง่าย ไม่ซับซ้อน"
        icon={<CoinIcon />}
        startFrame={0}
      />
    }
  />
);

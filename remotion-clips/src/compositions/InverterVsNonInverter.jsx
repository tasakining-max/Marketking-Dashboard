import {
  AbsoluteFill, useCurrentFrame, interpolate, spring,
  useVideoConfig, Img, staticFile,
} from 'remotion';
import { SilverDivider } from '../components/SilverDivider';
import { loadFrutiger } from '../utils/fonts';

loadFrutiger();

const FONT = 'Frutiger, sans-serif';

const BRAND = {
  navy:    '#001222',
  blue:    '#0074A2',
  darkBlue:'#005A82',
  cyan:    '#00C8E0',
  white:   '#FFFFFF',
  silver:  '#F5F5F5',
};

// ─── Product Section (top or bottom half) ────────────────────────────────────
const ProductSection = ({ type, startFrame, bg, dicut, model }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lf = Math.max(0, frame - startFrame);
  const isInverter = type === 'inverter';


  // Product image: snap in fast
  const imgSp = spring({ frame: lf, fps, config: { damping: 18, stiffness: 200 } });
  const imgScale  = interpolate(imgSp, [0, 1], [0.88, 1]);
  const imgOpacity= interpolate(lf, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
  const blur      = interpolate(lf, [0, 8], [12, 0], { extrapolateRight: 'clamp' });

  // Continuous float
  const floatY = Math.sin(frame * 0.038) * 12;

  // Glow pulse
  const glow = 0.45 + 0.3 * Math.sin(frame * 0.065);
  const glowColor = isInverter
    ? `rgba(0,116,162,${glow})`
    : `rgba(200,210,230,${glow * 0.7})`;

  // Label — snap in with image
  const labelOp  = interpolate(lf, [4, 10], [0, 1], { extrapolateRight: 'clamp' });
  const labelSlide= interpolate(lf, [4, 10], [16, 0], { extrapolateRight: 'clamp' });

  const accent = isInverter ? BRAND.cyan : BRAND.silver;

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Background — same color scheme as info scenes */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: isInverter
          ? 'radial-gradient(ellipse at 25% 20%, rgba(255,255,255,0.06) 0%, transparent 55%), linear-gradient(160deg, #0082B4 0%, #004570 100%)'
          : 'radial-gradient(ellipse at 75% 15%, rgba(255,255,255,0.03) 0%, transparent 50%), linear-gradient(160deg, #0C1318 0%, #16202E 50%, #1E2A3C 80%, #080D14 100%)',
      }} />
      {/* Product + glow */}
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: imgOpacity,
      }}>
        {/* Ambient glow */}
        <div style={{
          position: 'absolute',
          width: 560,
          height: 560,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${glowColor} 0%, transparent 65%)`,
          filter: 'blur(48px)',
          transform: `translateY(${floatY * 0.3}px)`,
        }} />

        <Img
          src={dicut}
          style={{
            width: isInverter ? '80%' : '72%',
            maxHeight: isInverter ? '88%' : '82%',
            objectFit: 'contain',
            filter: `drop-shadow(0 28px 36px rgba(0,0,0,0.45)) drop-shadow(0 20px 48px ${glowColor}) blur(${blur}px)`,
            transform: `scale(${imgScale}) translateY(${floatY}px)`,
            position: 'relative',
          }}
        />
      </div>
      {/* Label */}
      <div style={{
        position: 'absolute',
        [isInverter ? 'bottom' : 'top']: 80,
        left: 0,
        right: 0,
        textAlign: 'center',
        opacity: labelOp,
        transform: `translateY(${isInverter ? labelSlide : -labelSlide}px)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}>
        <span style={{
          color: accent,
          fontSize: 72,
          fontFamily: FONT,
          fontWeight: 900,
          letterSpacing: 8,
          textShadow: `0 0 40px ${accent}99, 0 0 80px ${accent}44`,
        }}>
          {isInverter ? 'INVERTER' : 'NON-INVERTER'}
        </span>
        <span style={{
          color: 'rgba(255,255,255,0.65)',
          fontSize: 36,
          fontFamily: FONT,
          fontWeight: 400,
          letterSpacing: 4,
        }}>
          {model}
        </span>
      </div>
    </div>
  );
};

// ─── Main Composition ─────────────────────────────────────────────────────────
export const InverterVsNonInverter = ({
  bgInverter,
  bgNonInverter,
  dicutInverter,
  dicutNonInverter,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });

  // Divider
  const dividerW   = interpolate(frame, [26, 50], [0, 100], { extrapolateRight: 'clamp' });
  const dividerGlow= 0.55 + 0.35 * Math.sin(frame * 0.07);

  // VS badge spring
  const vsSp    = spring({ frame: Math.max(0, frame - 46), fps, config: { damping: 8, stiffness: 240, mass: 0.65 } });
  const vsScale = interpolate(vsSp, [0, 1], [0, 1]);

  // VS outer ring pulse
  const ringScale  = 1 + 0.1 * Math.sin(frame * 0.09);
  const ringOpacity= 0.28 + 0.22 * Math.sin(frame * 0.09);

  return (
    <AbsoluteFill style={{ opacity: fadeIn, background: '#000010' }}>
      {/* TOP — Inverter */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '50%' }}>
        <ProductSection
          type="inverter"
          startFrame={0}
          bg={bgInverter}
          dicut={dicutInverter}
          model="FWCE-I-AF1M"
        />
      </div>
      {/* BOTTOM — Non-Inverter */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '50%' }}>
        <ProductSection
          type="non-inverter"
          startFrame={7}
          bg={bgNonInverter}
          dicut={dicutNonInverter}
          model="FWCE-AF2M"
        />
      </div>
      <SilverDivider />
      {/* Tasaki Logo */}
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
      {/* VS Badge */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: `translate(-50%, -50%) scale(${vsScale})`,
        zIndex: 10,
      }}>
        {/* Pulsing outer ring */}
        <div style={{
          position: 'absolute',
          inset: -18,
          borderRadius: '50%',
          border: `1.5px solid rgba(210,204,196,0.5)`,
          transform: `scale(${ringScale})`,
          opacity: ringOpacity,
        }} />
        {/* Second ring */}
        <div style={{
          position: 'absolute',
          inset: -8,
          borderRadius: '50%',
          border: `1px solid rgba(255,255,255,0.2)`,
          transform: `scale(${1 + (1 - ringScale) * 0.5})`,
          opacity: ringOpacity * 0.6,
        }} />

        <div style={{
          width: 120,
          height: 120,
          borderRadius: '50%',
          background: 'linear-gradient(145deg, #F1F0EE 0%, #C6C2BF 40%, #9A9693 70%, #D3D1CE 100%)',
          border: '3px solid rgba(254,253,252,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 0 48px rgba(206,202,198,0.6), inset 0 1px 0 rgba(255,255,255,0.12)',
        }}>
          <span style={{
            color: BRAND.navy,
            fontSize: 42,
            fontWeight: 900,
            fontFamily: FONT,
            letterSpacing: -1,
          }}>VS</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

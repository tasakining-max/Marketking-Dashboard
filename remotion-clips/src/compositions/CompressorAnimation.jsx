import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig, Sequence } from 'remotion';
import { SilverDivider } from '../components/SilverDivider';
import { Compressor } from '../components/Compressor';
import { SpeedGraph } from '../components/SpeedGraph';
import { loadFrutiger } from '../utils/fonts';

loadFrutiger();

const FONT = 'Frutiger, sans-serif';

const BRAND = {
  navy: '#001F33',
  blue: '#0074A2',
  darkBlue: '#005A82',
  cyan: '#00C8E0',
  white: '#FFFFFF',
  silver: '#F5F5F5',
  gray: '#888888',
};

// ===== PANEL สำหรับแต่ละ type =====
const CompressorPanel = ({ type, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = Math.max(0, frame - startFrame);

  const fadeIn = interpolate(localFrame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
  const slideY = interpolate(localFrame, [0, 8], [20, 0], { extrapolateRight: 'clamp' });

  const isInverter = type === 'inverter';

  // Compressor RPM — inverter: smooth sine variation, non-inverter: on/off
  const period = 60;
  const cycle = localFrame % period;
  const nonInvRpm = cycle < period * 0.55 ? 3.5 : 0;
  const invRpm = 1.5 + Math.sin(localFrame * 0.05) * 0.8;
  const rpm = isInverter ? invRpm : nonInvRpm;

  // Glow intensity
  const glowOpacity = isInverter
    ? 0.3 + 0.15 * Math.sin(localFrame * 0.08)
    : (cycle < period * 0.55 ? 0.45 : 0);

  const color = isInverter ? BRAND.white : BRAND.gray;
  const accentColor = isInverter ? BRAND.cyan : BRAND.silver;

  // Status dot pulse
  const dotPulse = isInverter
    ? 0.6 + 0.4 * Math.sin(localFrame * 0.12)
    : (cycle < period * 0.55 ? 1 : 0.15);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      opacity: fadeIn,
      transform: `translateY(${slideY}px)`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
      padding: `${isInverter ? '180px' : '16px'} 40px ${isInverter ? '100px' : '80px'} 40px`,
    }}>

      {/* Status indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, alignSelf: 'flex-start' }}>
        <div style={{
          width: 16, height: 16, borderRadius: '50%',
          background: accentColor,
          opacity: dotPulse,
          boxShadow: `0 0 ${16 * dotPulse}px ${accentColor}`,
        }} />
        <span style={{
          color: BRAND.white,
          fontSize: 33,
          fontWeight: 700,
          fontFamily: FONT,
          letterSpacing: 2,
          opacity: 0.9,
        }}>
          {isInverter ? 'INVERTER' : 'NON-INVERTER'}
        </span>
      </div>

      {/* Compressor + glow — ใหญ่และเด่น */}
      <div style={{ position: 'relative', margin: '8px 0' }}>
        <div style={{
          position: 'absolute',
          inset: -50,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${color} 0%, transparent 70%)`,
          opacity: glowOpacity,
          filter: 'blur(30px)',
        }} />
        <Compressor rpm={rpm} color={color} size={260} />

        {/* RPM label */}
        <div style={{
          position: 'absolute',
          bottom: -36,
          left: '50%',
          transform: 'translateX(-50%)',
          color: accentColor,
          fontSize: 21,
          fontFamily: FONT,
          whiteSpace: 'nowrap',
          fontWeight: 700,
        }}>
          {isInverter
            ? `${Math.round(rpm * 1000)} RPM`
            : (cycle < period * 0.55 ? '3500 RPM' : '0 RPM — OFF')}
        </div>
      </div>

      {/* Speed graph */}
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 32 }}>
        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 17, fontFamily: FONT, marginBottom: 4, textAlign: 'center' }}>
          COMPRESSOR SPEED
        </div>
        <SpeedGraph type={type} />
      </div>

      {/* Key stat */}
      <div style={{ textAlign: 'center', width: '100%' }}>
        <div style={{ color: accentColor, fontSize: 54, fontWeight: 900, fontFamily: FONT }}>
          {isInverter ? 'หมุนช้า-เร็วต่อเนื่อง' : 'หมุนเต็มที่ → หยุด → หมุนใหม่'}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 36, fontFamily: FONT, marginTop: 8 }}>
          {isInverter ? 'ปรับความเร็วตามอุณหภูมิ' : 'เปิด-ปิดซ้ำ ทุกรอบ'}
        </div>
      </div>

    </div>
  );
};

// ===== MAIN COMPOSITION =====
export const CompressorAnimation = () => {
  const frame = useCurrentFrame();

  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });

  // Divider line
  const dividerW    = interpolate(frame, [20, 45], [0, 100], { extrapolateRight: 'clamp' });
  const dividerGlow = 0.5 + 0.4 * Math.sin(frame * 0.08);

  // VS badge
  const { fps } = useVideoConfig();
  const vsSpring = spring({ frame: Math.max(0, frame - 38), fps, config: { damping: 10, stiffness: 180 } });
  const vsScale = interpolate(vsSpring, [0, 1], [0, 1]);

  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>

      {/* Background — same color scheme as info scenes */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '50%',
        background: 'radial-gradient(ellipse at 25% 20%, rgba(255,255,255,0.06) 0%, transparent 55%), linear-gradient(160deg, #0082B4 0%, #004570 100%)' }} />
      <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '50%',
        background: 'radial-gradient(ellipse at 75% 15%, rgba(255,255,255,0.03) 0%, transparent 50%), linear-gradient(160deg, #0C1318 0%, #16202E 50%, #1E2A3C 80%, #080D14 100%)' }} />

      {/* TOP — Inverter */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '50%' }}>
        <CompressorPanel type="inverter" startFrame={0} />
      </div>

      {/* BOTTOM — Non-Inverter */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '50%' }}>
        <CompressorPanel type="non-inverter" startFrame={3} />
      </div>

      <SilverDivider />

      {/* VS badge */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: `translate(-50%, -50%) scale(${vsScale})`,
        zIndex: 10,
        width: 120,
        height: 120,
        borderRadius: '50%',
        background: 'linear-gradient(145deg, #F1F0EE 0%, #C6C2BF 40%, #9A9693 70%, #D3D1CE 100%)',
        border: '3px solid rgba(254,253,252,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 0 40px rgba(206,202,198,0.6)',
      }}>
        <span style={{
          color: BRAND.navy,
          fontSize: 42,
          fontWeight: 900,
          fontFamily: FONT,
          letterSpacing: -1,
        }}>VS</span>
      </div>

    </AbsoluteFill>
  );
};

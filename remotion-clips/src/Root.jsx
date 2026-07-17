import { Composition, staticFile } from 'remotion';
import { InverterVsNonInverter } from './compositions/InverterVsNonInverter';
import { CompressorAnimation } from './compositions/CompressorAnimation';
import { PriceScene } from './compositions/PriceScene';
import { SoundScene } from './compositions/SoundScene';
import { RoomScene } from './compositions/RoomScene';
import { MaintenanceScene } from './compositions/MaintenanceScene';
import { TemperatureScene } from './compositions/TemperatureScene';
import { TemperatureDropOverlay } from './compositions/TemperatureDropOverlay';
import { TemperatureDropGreenScreen } from './compositions/TemperatureDropGreenScreen';
import { FanSwingOverlay } from './compositions/FanSwingOverlay';
import { FanSwingGreenScreen } from './compositions/FanSwingGreenScreen';
import { TakujungScene } from './compositions/TakujungScene';
import { SaltSprayTestOverlay } from './compositions/SaltSprayTestOverlay';
import { SaltSprayTestGreenScreen } from './compositions/SaltSprayTestGreenScreen';

export const RemotionRoot = () => (
  <>
    <Composition
      id="InverterVsNonInverter"
      component={InverterVsNonInverter}
      durationInFrames={150}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        bgInverter: staticFile('BG.png'),
        bgNonInverter: staticFile('BG.png'),
        dicutInverter: staticFile('Inverter.png'),
        dicutNonInverter: staticFile('non-inverter.png'),
      }}
    />
    <Composition
      id="CompressorAnimation"
      component={CompressorAnimation}
      durationInFrames={240}
      fps={30}
      width={1080}
      height={1920}
    />
    <Composition id="PriceScene"       component={PriceScene}       durationInFrames={180} fps={30} width={1080} height={1920} />
    <Composition id="SoundScene"       component={SoundScene}       durationInFrames={180} fps={30} width={1080} height={1920} />
    <Composition id="RoomScene"        component={RoomScene}        durationInFrames={180} fps={30} width={1080} height={1920} />
    <Composition id="MaintenanceScene" component={MaintenanceScene} durationInFrames={180} fps={30} width={1080} height={1920} />
    <Composition id="TemperatureScene" component={TemperatureScene} durationInFrames={180} fps={30} width={1080} height={1920} />
    <Composition id="TemperatureDropOverlay" component={TemperatureDropOverlay} durationInFrames={90} fps={30} width={1080} height={1920} />
    <Composition id="TemperatureDropGreenScreen" component={TemperatureDropGreenScreen} durationInFrames={90} fps={30} width={1080} height={1920} />
    <Composition id="FanSwingOverlay" component={FanSwingOverlay} durationInFrames={90} fps={30} width={1080} height={1920} />
    <Composition id="FanSwingGreenScreen" component={FanSwingGreenScreen} durationInFrames={90} fps={30} width={1080} height={1920} />
    <Composition id="TakujungScene"    component={TakujungScene}    durationInFrames={270} fps={30} width={1080} height={1920} />
    <Composition id="SaltSprayTestOverlay" component={SaltSprayTestOverlay} durationInFrames={324} fps={30} width={1080} height={1920} />
    <Composition id="SaltSprayTestGreenScreen" component={SaltSprayTestGreenScreen} durationInFrames={324} fps={30} width={1080} height={1920} />
  </>
);

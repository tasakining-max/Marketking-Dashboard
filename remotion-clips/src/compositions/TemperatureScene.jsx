import { SceneBase } from '../components/SceneBase';
import { InfoPanel } from '../components/InfoPanel';
import { Thermometer } from '../components/Thermometer';

export const TemperatureScene = () => (
  <SceneBase
    top={
      <InfoPanel
        type="inverter"
        mainText="เย็นแล้วเสถียร"
        subText={"รักษาอุณหภูมิได้นิ่ง\nไม่ต้องทำงานหนักซ้ำ"}
        icon={<Thermometer type="inverter" startFrame={0} />}
        startFrame={0}
      />
    }
    bottom={
      <InfoPanel
        type="non-inverter"
        mainText="เย็นเร็ว หยุดเป็นช่วง"
        subText={"ตัดต่อทำงานเป็นรอบ\nอุณหภูมิแกว่งขึ้นลง"}
        icon={<Thermometer type="non-inverter" startFrame={0} />}
        startFrame={0}
      />
    }
  />
);

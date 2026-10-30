# Vector Kit (คลังชิ้นเวกเตอร์ให้ประกอบ)

หนิงสร้างไฟล์ .svg หรือ .vectorcraft ใส่ในโฟลเดอร์ตามชนิด ประกอบ (ทีมภาพ) จะหยิบไปวางเป็นเลเยอร์ในแอดแทนการวาดเอง

- labels/  ฉลากทางการ เช่น ฉลากเบอร์ 5 (ใช้ตามจริง ห้ามแก้ตัวเลขหรือรูปทรง)
- badges/  badge ต่างๆ เช่น รับประกัน ผลิตในไทย Inverter Solar Hybrid
- icons/   ไอคอนเส้น/แบน
- shapes/  ริบบิ้น แถบ ป้ายชื่อรุ่น เส้นพลังงาน เกล็ดหิมะ แสงดวงอาทิตย์

ตั้งชื่อไฟล์เป็นอังกฤษตัวเล็ก ขีดกลาง เช่น energy-label-5.svg, badge-warranty-5y.svg
พื้นหลังโปร่งใส ใช้สีแบรนด์ (Tasaki Blue #0074A2, ซีอัน #8FE3FF)
ใส่ไฟล์ _notes.txt ในโฟลเดอร์ได้ ถ้ามีเงื่อนไขการใช้ เช่น ใช้ได้เฉพาะรุ่นที่ได้เบอร์ 5 จริง

## logos/ (ใส่แล้ว 2026-10-24)
ทั้งหมดเป็นไฟล์ PNG พื้นโปร่งใส (ที่ได้รับมาเป็นภาพ ไม่ใช่เวกเตอร์ต้นฉบับ) ถ้ามีไฟล์ .svg/.ai/.pdf ต้นฉบับ ให้วางทับในโฟลเดอร์นี้ ประกอบจะใช้ไฟล์เวกเตอร์ก่อน
- tasaki-blue.png / tasaki-blue-tagline-en.png (Air Conditioning From Thailand) / tasaki-blue-tagline-th.png / tasaki-symbol-blue.png (ใบพัดอย่างเดียว) / tasaki-grey.png / tasaki-black.png
- inverter-wordmark-grey.png คำว่า INVERTER
- energy-conservation-2020-symbol.png และ badges/energy-conservation-2020-badge.png (ตราบริษัทอนุรักษ์พลังงาน 2020)
- bitwise-group.png, bitwise-heat-exchanger.png (บริษัทในเครือ ใช้เฉพาะงานที่เกี่ยวข้อง ไม่ใช่โลโก้แอด Tasaki)
- สีแบรนด์ดูที่ brand-colors.jpg: Tasaki Blue #0074A2 (PANTONE 307U ผิวด้าน), #0076A8 (PANTONE 7690C ผิวมัน), เทา PANTONE P 179-8 U
- ใช้โลโก้ตามไฟล์ ห้ามยืด บิด หรือเปลี่ยนสี

## badges/ (แกะจากเว็บ 2026-10-24)
badge-*.vectorcraft / .svg 8 ชิ้น: solar, chilled-water, wifi, 6in1-filter, pm25, self-clean, plasma-option, anti-corrosion
แกะด้วย Image Trace ของ VectorCraft (ไอคอน+ตัวอักษร) แล้วประกอบกรอบเงิน พื้นดำ เงาสะท้อน ด้วยเลเยอร์เวกเตอร์ แยกเลเยอร์: frame / plate / icon ต้นทางคือ public/badges/all-badges.webp ของเว็บ (ภาพต้นฉบับความละเอียดต่ำ ขอบตัวอักษรจึงไม่คมเท่าไฟล์ออกแบบจริง)

- badge-warranty-5y.svg / .vectorcraft (2026-10-29): ป้าย "5 YEARS WARRANTY COMPRESSOR" เวกเตอร์ 480×376 สร้างใหม่ตามภาพที่หนิงส่งมา (ไม่ได้ trace) ป้ายเงินตัดมุมซ้ายล่าง ตัวหนังสือ Frutiger (5/WARRANTY Bold, YEARS/COMPRESSOR Regular หนาขึ้นด้วยเส้นขอบ) แปลงเป็น outline แล้ว แยกเลเยอร์ plate / years-box / text ใช้ได้เฉพาะรุ่นที่รับประกันคอมเพรสเซอร์ 5 ปีจริง
- badge-warranty-10y / -5y-parts / -2y-parts / -1y / -1y-parts (.svg / .vectorcraft, 2026-10-29): ชุดป้ายประกันดีไซน์เดียวกับป้าย 5 ปี ตามหมายเหตุ Price list 2026 Rev03
  - 10 YEARS WARRANTY COMPRESSOR: FWEE-I-AF1M เท่านั้น (ป้ายกว้าง 653 เพราะเลขสองหลัก)
  - 5 YEARS WARRANTY COMPRESSOR (ป้ายเดิม) + 5 YEARS WARRANTY PARTS: FWCE-AF2M, FWCE-I-AF1M, FWCE-I-AF1M Solar (คอมเพรสเซอร์และอุปกรณ์อื่น 5 ปี)
  - 5 YEARS WARRANTY COMPRESSOR (ป้ายเดิม) + 2 YEARS WARRANTY PARTS: FUNE, FCHE/FCAE/FCME, FSCE, FIDE, FFSE ทุกรุ่นรวม Solar
  - 1 YEAR WARRANTY COMPRESSOR + 1 YEAR WARRANTY PARTS: FDS, FFS-C-AD2, AHU -AD2/-CD2, WCB, ACP, CVB, AWHP, Chiller, Panel Air (คอมเพรสเซอร์และอุปกรณ์อื่น 1 ปี)
  - 1 YEAR WARRANTY PARTS อย่างเดียว: ระบบน้ำ FUL, FCC, FCD, FCE, FFS-AW1, AHU -AW1/-CW1 (รับประกันอุปกรณ์ 1 ปี ไม่มีคอมเพรสเซอร์)
  - ทุกแบบแยกป้ายคอมเพรสเซอร์กับอุปกรณ์เป็น 2 ใบ
  - ใส่ในแอดต้องมีตัวเล็ก "ตามเงื่อนไขการรับประกันของบริษัทฯ"

## shapes/ (2026-10-24)
- tasaki-corner-shape.svg / .vectorcraft / .png — ใบพัดโลโก้ Tasaki 1 ใบ ไล่เฉดน้ำเงิน (#1764A0 → #1879BF → #176DA2 → #165E82) เงาตกกระทบนุ่ม องค์ประกอบหลัก ใช้ได้เสมอ: เปลี่ยนสี (ชุดสีแบรนด์) ย่อ ขยาย หมุน ล้นขอบ ทำโปร่งใส หรือเหลือแต่เส้นขอบ ใช้แทนกล่องสี่เหลี่ยมใส่รูป (เป็นกรอบ/มาสก์รูป ป้าย ไอคอน มุมภาพ) ห้ามเปลี่ยนสัดส่วนรูปทรง

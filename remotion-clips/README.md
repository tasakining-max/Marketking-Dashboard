# Tasaki Clips — Remotion

## Setup
```bash
cd remotion-clips
npm install
npm start
```

## วางไฟล์รูปใน /public
| ไฟล์ | คือ |
|---|---|
| `bg-inverter.png` | BG จาก Midjourney (top half) |
| `bg-non-inverter.png` | BG จาก Midjourney (bottom half) |
| `dicut-inverter.png` | ไดคัท Inverter (PNG transparent) |
| `dicut-non-inverter.png` | ไดคัท Non-Inverter (PNG transparent) |

## Render
```bash
npm run build
# output → out/inverter-vs-non-inverter.mp4
```

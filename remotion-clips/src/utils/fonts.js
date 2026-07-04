import { delayRender, continueRender, staticFile } from 'remotion';

let _loaded = false;

export function loadFrutiger() {
  if (_loaded) return;
  _loaded = true;

  const handle = delayRender('Loading Frutiger fonts');

  const faces = [
    { weight: 300, file: 'LT_46521TH.otf' },
    { weight: 400, file: 'LT_46525TH.otf' },
    { weight: 700, file: 'LT_46529TH.otf' },
    { weight: '700italic', file: 'LT_46530TH.otf' },
  ];

  Promise.all(
    faces.map(({ weight, file }) => {
      const style = String(weight).includes('italic') ? 'italic' : 'normal';
      const w = parseInt(weight);
      const face = new FontFace('Frutiger', `url(${staticFile('front/' + file)})`, {
        weight: String(w),
        style,
      });
      return face.load().then((f) => document.fonts.add(f)).catch(() => {});
    })
  )
    .then(() => continueRender(handle))
    .catch(() => continueRender(handle));
}

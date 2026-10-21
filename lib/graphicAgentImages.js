import fs from 'node:fs';
import path from 'node:path';

// Follow explicit task links so a VectorCraft edit stays on its original card.
export function latestGraphicAgentImages(tasks, events, { cards = [], resolveImage = (image) => image } = {}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const matchingCard = (headline) => {
    if (!headline) return null;
    const matches = cards.filter((card) => card.title.trim() === headline.trim());
    return matches.length === 1 ? matches[0].id : null;
  };
  const cardFor = (id, seen = new Set()) => {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const input = byId.get(id)?.input;
    return input?.graphicCardId
      || cardFor(input?.sourceTaskId, seen)
      || cardFor(input?.sourceRoot, seen)
      || matchingCard(input?.headline);
  };
  const images = new Map();
  const preferredFor = (id, seen = new Set()) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const input = byId.get(id)?.input;
    return input?.graphicCardPreview === true
      || preferredFor(input?.sourceTaskId, seen)
      || preferredFor(input?.sourceRoot, seen);
  };
  const add = (taskId, image, date) => {
    if (typeof image !== 'string' || !image.startsWith('/uploads/agent-images/')) return;
    const cardId = cardFor(taskId);
    if (!cardId) return;
    image = resolveImage(image);
    if (!image) return;
    const time = new Date(date).getTime();
    const preferred = preferredFor(taskId);
    const previous = images.get(cardId);
    if (!previous || (preferred && !previous.preferred) || (preferred === previous.preferred && time >= previous.time)) {
      const result = byId.get(taskId)?.result;
      const cleanImage = image.split('?')[0];
      const document = result?.images?.[0]?.split('?')[0] === cleanImage && result?.document
        ? result.document.split('?')[0]
        : /\/r[0-9a-z]+-1\.png$/.test(cleanImage) ? cleanImage.replace(/-1\.png$/, '.vectorcraft') : null;
      images.set(cardId, { image, time, preferred, document });
    }
  };
  for (const task of tasks) {
    const selectedAt = task.input?.graphicCardPreview && task.updatedAt;
    add(task.id, task.result?.images?.[0], selectedAt || task.finishedAt || task.updatedAt);
  }
  for (const event of events) {
    if (event.agent !== 'you') add(event.taskId, event.image, event.createdAt);
  }
  return images;
}

// Save the approved image as a snapshot, rather than a link to a changing draft.
export async function attachApprovedGraphicImage(task, body, { prisma, invalidateCache, root }) {
  const chosen = task.result?.images?.[Number(body.image) || 0] || task.result?.images?.[0];
  if (!chosen) return null;
  const [sources, cards] = await Promise.all([
    prisma.agentTask.findMany({ where: { agent: { in: ['image', 'assemble'] } }, select: { id: true, input: true } }),
    prisma.graphicDesignCard.findMany({ select: { id: true, title: true } }),
  ]);
  const images = latestGraphicAgentImages([
    ...sources.filter((t) => t.id !== task.id),
    { ...task, result: { images: [chosen] }, finishedAt: new Date() },
  ], [], { cards });
  const match = images.entries().next().value;
  if (!match) return null;
  const [cardId] = match;
  const file = path.resolve(root, 'public', `.${chosen.split('?')[0]}`);
  if (!file.startsWith(path.join(root, 'public', 'uploads', 'agent-images') + path.sep)) throw new Error('ไฟล์ภาพไม่อยู่ในโฟลเดอร์ทีม AI');
  const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : 'image/png';
  await prisma.graphicDesignCard.update({
    where: { id: cardId },
    data: { imageUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`, column: 'done' },
    omit: { imageUrl: true },
  });
  invalidateCache('graphic-cards');
  return 'แนบภาพที่อนุมัติลงการ์ด Graphic Design แล้ว (เสร็จแล้ว)';
}

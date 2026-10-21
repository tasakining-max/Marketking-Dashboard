import test from 'node:test';
import assert from 'node:assert/strict';
import { latestGraphicAgentImages, attachApprovedGraphicImage } from '../lib/graphicAgentImages.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const image = (name) => `/uploads/agent-images/${name}.png`;

test('uses the newest chat preview even when a task fails before returning images', () => {
  const tasks = [{ id: 'draft', input: { graphicCardId: 'card' }, result: {} }];
  const events = [
    { taskId: 'draft', agent: 'assemble', image: image('new'), createdAt: '2026-10-20T09:00:00Z' },
    { taskId: 'draft', agent: 'assemble', image: image('old'), createdAt: '2026-10-20T08:00:00Z' },
    { taskId: 'draft', agent: 'you', image: image('reference'), createdAt: '2026-10-20T10:00:00Z' },
  ];
  assert.equal(latestGraphicAgentImages(tasks, events).get('card').image, image('new'));
});

test('follows nested VectorCraft edits without mixing unrelated cards', () => {
  const tasks = [
    { id: 'original', input: { graphicCardId: 'card' }, result: { images: [image('original')] }, finishedAt: '2026-10-20T08:00:00Z' },
    { id: 'edit', input: { sourceTaskId: 'original' } },
    { id: 'edit2', input: { sourceTaskId: 'edit' }, result: { images: [image('edited')] }, finishedAt: '2026-10-20T09:00:00Z' },
    { id: 'unrelated', input: {}, result: { images: [image('unrelated')] }, finishedAt: '2026-10-20T10:00:00Z' },
  ];
  const previews = latestGraphicAgentImages(tasks, []);
  assert.equal(previews.size, 1);
  assert.equal(previews.get('card').image, image('edited'));
});

test('handles broken source links and cycles using the recorded source root', () => {
  const tasks = [
    { id: 'original', input: { graphicCardId: 'card' } },
    { id: 'edit', input: { sourceTaskId: 'edit', sourceRoot: 'original' }, result: { images: [image('edited')] }, finishedAt: '2026-10-20T09:00:00Z' },
  ];
  assert.equal(latestGraphicAgentImages(tasks, []).get('card').image, image('edited'));
});

test('recovers unlinked chat jobs by a unique matching headline and skips missing files', () => {
  const tasks = [{ id: 'draft', input: { headline: 'Blue fin' }, result: { images: [image('deleted')] }, finishedAt: '2026-10-20T10:00:00Z' }];
  const events = [{ taskId: 'draft', agent: 'assemble', image: image('available'), createdAt: '2026-10-20T09:00:00Z' }];
  const options = { cards: [{ id: 'card', title: 'Blue fin' }], resolveImage: (url) => url === image('deleted') ? null : url };
  assert.equal(latestGraphicAgentImages(tasks, events, options).get('card').image, image('available'));
  options.cards.push({ id: 'another', title: 'Blue fin' });
  assert.equal(latestGraphicAgentImages(tasks, events, options).size, 0);
});

test('final approval saves the selected artwork and marks its original card done', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphic-approval-'));
  try {
    const dir = path.join(root, 'public', 'uploads', 'agent-images');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'selected.png'), 'approved artwork');
    const sources = [{ id: 'original', input: { graphicCardId: 'card' } }];
    let saved;
    let invalidated;
    const prisma = {
      agentTask: { findMany: async () => sources },
      graphicDesignCard: {
        findMany: async () => [{ id: 'card', title: 'Artwork' }],
        update: async (args) => { saved = args; },
      },
    };
    const task = { id: 'edit', input: { sourceTaskId: 'original' }, result: { images: [image('unselected'), image('selected')] } };
    await attachApprovedGraphicImage(task, { image: 1 }, { prisma, root, invalidateCache: (key) => { invalidated = key; } });
    assert.equal(saved.where.id, 'card');
    assert.equal(saved.data.column, 'done');
    assert.equal(saved.data.imageUrl, `data:image/png;base64,${Buffer.from('approved artwork').toString('base64')}`);
    assert.equal(invalidated, 'graphic-cards');
    fs.writeFileSync(path.join(dir, 'selected.png'), 'later draft');
    assert.equal(Buffer.from(saved.data.imageUrl.split(',')[1], 'base64').toString(), 'approved artwork');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('approving a plan without images does not complete a graphic card', async () => {
  const result = await attachApprovedGraphicImage({ result: { stage: 'planned' } }, {}, {});
  assert.equal(result, null);
});

test('keeps the selected artwork and its edits ahead of another design on the same card', () => {
  const tasks = [
    { id: 'selected', input: { graphicCardId: 'card', graphicCardPreview: true }, result: { images: [image('selected')] }, finishedAt: '2026-10-20T08:00:00Z' },
    { id: 'other', input: { graphicCardId: 'card' }, result: { images: [image('other')] }, finishedAt: '2026-10-20T10:00:00Z' },
    { id: 'edit', input: { sourceTaskId: 'selected' }, result: { images: [image('edited')] }, finishedAt: '2026-10-20T09:00:00Z' },
  ];
  assert.equal(latestGraphicAgentImages(tasks, []).get('card').image, image('edited'));
});

test('an explicitly selected version supersedes older chat images from the same task', () => {
  const tasks = [{ id: 'selected', input: { graphicCardId: 'card', graphicCardPreview: true }, result: { images: [image('user-edited')] }, finishedAt: '2026-10-20T08:00:00Z', updatedAt: '2026-10-21T01:00:00Z' }];
  const events = [{ taskId: 'selected', agent: 'layout', image: image('old-round'), createdAt: '2026-10-20T09:00:00Z' }];
  assert.equal(latestGraphicAgentImages(tasks, events).get('card').image, image('user-edited'));
});

test('opens the document matching the displayed image, including an earlier chat round', () => {
  const tasks = [{ id: 'draft', input: { graphicCardId: 'card' }, result: { images: [image('custom-preview')], document: '/uploads/agent-images/edited.vectorcraft' }, finishedAt: '2026-10-20T08:00:00Z' }];
  assert.equal(latestGraphicAgentImages(tasks, []).get('card').document, '/uploads/agent-images/edited.vectorcraft');
  const events = [{ taskId: 'draft', agent: 'assemble', image: '/uploads/agent-images/draft/r2b-1.png', createdAt: '2026-10-20T09:00:00Z' }];
  assert.equal(latestGraphicAgentImages(tasks, events).get('card').document, '/uploads/agent-images/draft/r2b.vectorcraft');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { adFacts, adNumbersOk, adPlainText } from '../lib/agentTeam.js';

const day = (n) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d; };
const row = (n, adId, spend, clicks, impressions = 1000) => ({ date: day(n), adId, campaignName: 'C', creativeName: `ad-${adId}`, spend, clicks, impressions });
const fake = (rows) => ({ adInsight: { findMany: async () => [...rows].sort((a, b) => a.date - b.date) } });

test('no recent data is reported as no_data, not as zero spend', async () => {
  const f = await adFacts(fake([row(9, 'a', 100, 10)]));
  assert.equal(f.status, 'no_data');
  assert.match(adPlainText(f), /ยังไม่มีข้อมูล/);
});

test('flags a CPC jump, a CPC over the line and a stopped ad', async () => {
  const rows = [
    ...[2, 3, 4, 5].map((n) => row(n, 'up', 50, 10)),    // CPC 5 before
    row(1, 'up', 100, 10),                               // CPC 10 yesterday: +100%
    ...[2, 3, 4].map((n) => row(n, 'stop', 40, 8)),
    row(1, 'stop', 0, 0),                                // stopped
  ];
  const f = await adFacts(fake(rows));
  const flags = f.flags.map((x) => `${x.ad}:${x.flag}`);
  assert.ok(flags.includes('ad-up:ค่าคลิกพุ่ง'));
  assert.ok(flags.includes('ad-stop:หยุดใช้งบ'));
  assert.equal(f.totals.spend, 100);
});

test('a normal day raises no flags', async () => {
  const rows = [...[1, 2, 3, 4].map((n) => row(n, 'ok', 50, 10))];
  const f = await adFacts(fake(rows));
  assert.equal(f.flags.length, 0);
  assert.equal(f.status, 'ok');
});

test('numbers in the written text must come from the facts', async () => {
  const f = await adFacts(fake([...[1, 2, 3].map((n) => row(n, 'ok', 50, 10))]));
  assert.ok(adNumbersOk('ใช้เงินรวม ฿50 ได้ 10 คลิก', f).ok);
  assert.ok(!adNumbersOk('ใช้เงินรวม ฿73 ได้ 41 คลิก', f).ok);
});

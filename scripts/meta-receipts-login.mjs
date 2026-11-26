// Opens the separate Chrome profile used for downloading Meta ad receipts, so
// she can log in to Facebook once. Close the window when done.
import { chromium } from 'playwright';
import { PROFILE_DIR, BILLING_URL } from '../lib/metaReceipts.js';

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: false, viewport: null, acceptDownloads: true });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(BILLING_URL);
await new Promise((resolve) => ctx.on('close', resolve));

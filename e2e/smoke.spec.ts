import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke test: the whole app on demo data (MockProvider), desktop + phone.
 * Each test starts from a clean browser (no cookies), on its own demo server + database.
 */

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 1024;

async function open(page: Page, symbol = 'AAPL') {
  await page.goto(`/stock/${symbol}`);
  await expect(page.locator('#price-title')).toHaveText(symbol);
  await expect(page.locator('div[role=img][aria-label^="Price chart"]')).toBeVisible();
}

test.describe('dashboard', () => {
  test('every section renders with demo data, and no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await open(page);

    // price header + status bar + footer
    await expect(page.locator('section', { has: page.locator('#price-title') })).toContainText('Apple Inc.');
    await expect(page.getByText(/Source: Mock/).first()).toBeVisible();
    await expect(page.getByText('US market:')).toBeVisible();
    await expect(page.getByText(/Data from .*Mock/)).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: /demo|mock/i })).toBeVisible();

    // AI summary: right under the price, visible without scrolling, with the headline mood
    const summary = page.locator('section[aria-labelledby="ai-summary-title"]');
    await expect(summary.getByRole('heading', { name: 'AI summary' })).toBeVisible();
    await expect(summary).toContainText(/Last 24 h headlines:/);
    const box = await summary.boundingBox();
    expect(box && box.y + Math.min(box.height, 120) <= page.viewportSize()!.height).toBe(true);
    await summary.getByRole('button', { name: /See all news/ }).click();
    await expect(page.getByRole('heading', { name: 'News', exact: true })).toBeInViewport();

    // chart + levels
    await expect(page.getByText(/Change over 1 day/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Key levels' })).toBeVisible();
    await expect(page.getByText('Pivot points', { exact: false })).toBeVisible();

    if (isPhone(page)) {
      // phone: one panel at a time behind tabs
      await expect(page.getByRole('tab', { name: 'News' })).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('tab', { name: 'Insight' }).click();
      await expect(page.getByRole('heading', { name: 'Leadership & profile' })).toBeVisible();
      await page.getByRole('tab', { name: 'Stats' }).click();
      await expect(page.getByRole('heading', { name: 'Key stats' })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: 'Watchlist' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'News' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Key stats' })).toBeVisible();
      await expect(page.getByText('Market cap')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Leadership & profile' })).toBeVisible();
      await expect(page.getByText('Tim Cook')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Next-year plan & guidance' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Analyst expectations' })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test('range buttons change the chart', async ({ page }) => {
    await open(page);
    await expect(page.getByText('5-min candles', { exact: true })).toBeVisible({ visible: !isPhone(page) });
    for (const [range, label, size] of [
      ['1Y', '1 year', 'Daily candles'],
      ['5Y', '5 years', 'Weekly candles'],
      ['1H', '1 hour', '1-min candles'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('div[role=img][aria-label^="Price chart"]')).toHaveAttribute('aria-label', new RegExp(label));
      if (!isPhone(page)) await expect(page.getByText(size, { exact: true })).toBeVisible();
      void range;
    }
  });

  test('layout has no horizontal scroll and every button has a name', async ({ page }) => {
    await open(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    const unnamed = await page.$$eval('button', (bs) =>
      bs.filter((b) => b.offsetParent !== null && !(b.getAttribute('aria-label') || b.textContent?.trim())).map((b) => b.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);
  });
});

test.describe('preferences', () => {
  test('language switch translates the UI and is remembered', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'TH', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    await expect(page.getByText('ตลาดสหรัฐฯ:')).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('light theme toggle is remembered after reload', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); // rendered by the server from the cookie
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the chart range and last symbol are restored', async ({ page }) => {
    await open(page, 'MSFT');
    await page.getByRole('button', { name: '1 month', exact: true }).click();
    await page.goto('/');
    await expect(page).toHaveURL(/\/stock\/MSFT$/);
    await expect(page.getByRole('button', { name: '1 month', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('search, watchlist, compare', () => {
  test('search by company name opens the stock', async ({ page }) => {
    await open(page);
    const search = page.getByRole('combobox', { name: 'Search ticker or company' });
    await search.fill('micro');
    await expect(page.getByRole('option', { name: /MSFT/ })).toBeVisible();
    await search.press('Enter');
    await expect(page).toHaveURL(/\/stock\/MSFT$/);
  });

  test('add and remove a watchlist symbol', async ({ page }) => {
    test.skip(isPhone(page), 'desktop sidebar');
    await open(page, 'AMD');
    await page.getByRole('button', { name: 'Add AMD to watchlist' }).click();
    const row = page.getByRole('link', { name: /^AMD/ });
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: 'More actions for AMD' }).first().click();
    await page.getByRole('button', { name: 'Remove AMD from watchlist' }).click();
    await expect(row).toHaveCount(0);
  });

  test('compare with SPY and MSFT, then remove one', async ({ page }) => {
    test.skip(isPhone(page), 'checked on desktop');
    await open(page);
    await page.getByRole('button', { name: /^Compare/ }).click();
    const dialog = page.getByRole('dialog', { name: /Compare AAPL with/ });
    await dialog.getByRole('button', { name: 'Compare with SPY' }).click();
    await expect(dialog).toContainText('1 of 2 added'); // stays open until both slots are used
    await dialog.getByRole('button', { name: 'Compare with MSFT' }).click();
    await expect(dialog).toBeHidden();
    const legend = page.getByRole('list', { name: 'Compared symbols' });
    await expect(legend).toContainText('SPY');
    await expect(legend).toContainText('MSFT');
    await expect(page.getByRole('button', { name: /^Compare/ })).toContainText('2/2');
    await page.getByRole('button', { name: 'Stop comparing SPY' }).click();
    await expect(legend).not.toContainText('SPY');
  });
});

test.describe('chart details', () => {
  test('crosshair tooltip shows OHLC, volume and change', async ({ page }) => {
    test.skip(isPhone(page), 'mouse hover');
    await open(page);
    const box = (await page.locator('div[role=img][aria-label^="Price chart"]').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4);
    const tip = page.getByRole('status').filter({ hasText: 'Volume' });
    await expect(tip).toContainText('Open');
    await expect(tip).toContainText('Close');
    await expect(tip).toContainText('Change');
  });

  test('keyboard shortcuts work, but not while typing', async ({ page }) => {
    test.skip(isPhone(page), 'keyboard');
    await open(page);
    const search = page.getByRole('combobox', { name: 'Search ticker or company' });
    await search.click();
    await search.press('3');
    await expect(page.getByRole('button', { name: '1 week', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await search.press('Escape');
    await page.locator('#price-title').click(); // move focus out of the input
    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: '1 week', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const levels = page.getByRole('button', { name: 'Levels', exact: true });
    const before = await levels.getAttribute('aria-pressed');
    await page.keyboard.press('l');
    await expect(levels).not.toHaveAttribute('aria-pressed', before!);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
  });
});

test.describe('alerts', () => {
  test('a price alert fires and shows a notification in the app', async ({ page, request }) => {
    await open(page);
    // Demo prices move every 250 ms: set one alert just above and one just below — one fires quickly.
    // The quote is cached for a few seconds while demo prices keep moving, so a target can already be on
    // the wrong side (400) — retry with a fresh price.
    for (const [kind, offset] of [['price_above', 0.02], ['price_below', -0.02]] as const) {
      let status = 0;
      for (let attempt = 0; attempt < 6 && status !== 201; attempt++) {
        const q = await (await request.get('http://localhost:4100/api/quote/AAPL')).json();
        const r = await request.post('http://localhost:4100/api/alerts', { data: { symbol: 'AAPL', kind, targetPrice: +(q.price + offset * (attempt + 1)).toFixed(2) } });
        status = r.status();
        if (status !== 201) await page.waitForTimeout(1000);
      }
      expect(status).toBe(201);
    }
    await expect(page.getByRole('status').filter({ hasText: 'AAPL alert' })).toBeVisible({ timeout: 45_000 });
    // clean up for the next tests
    for (const a of await (await request.get('http://localhost:4100/api/alerts')).json()) await request.delete(`http://localhost:4100/api/alerts/${a.id}`);
  });

  test('rejects a target on the wrong side of the price', async ({ request }) => {
    const q = await (await request.get('http://localhost:4100/api/quote/AAPL')).json();
    const r = await request.post('http://localhost:4100/api/alerts', { data: { symbol: 'AAPL', kind: 'price_above', targetPrice: +(q.price * 0.5).toFixed(2) } });
    expect(r.status()).toBe(400);
  });
});

test.describe('failures', () => {
  test('explains when the data server is unreachable, and recovers by itself', async ({ page }) => {
    await open(page);
    await page.route('**/api/health', (r) => r.fulfill({ status: 500, body: 'Internal Server Error' }));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('alert').filter({ hasText: 'Data server not reachable' })).toBeVisible({ timeout: 25_000 });
    await page.unroute('**/api/health');
    await expect(page.getByRole('alert').filter({ hasText: 'Data server not reachable' })).toHaveCount(0, { timeout: 20_000 });
  });

  test('unknown symbol shows a clear message', async ({ page }) => {
    await page.goto('/stock/ZZZZQ');
    await expect(page.getByText('Symbol not found')).toBeVisible();
  });
});

test.describe('installable app', () => {
  test('serves a manifest, icons and a service worker', async ({ page, request }) => {
    const m = await (await request.get('/manifest.webmanifest')).json();
    expect(m).toMatchObject({ name: 'Trading Monitor', display: 'standalone' });
    for (const icon of m.icons) expect((await request.get(icon.src)).headers()['content-type']).toContain('image/png');
    await open(page);
    const sw = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
    expect(sw).toMatch(/\/sw\.js$/);
  });
});

// ------------------------------------------------------------------ Phase 8: watchlist upgrades
const API = 'http://localhost:4100/api';
const SHOTS = process.env.SHOTS; // optional folder for screenshots

const watchlist = (page: Page) => page.locator('section[aria-labelledby="watchlist-title"]').filter({ visible: true });
const wlSymbols = (page: Page) =>
  watchlist(page).locator('li[data-symbol]').evaluateAll((els) => els.map((el) => el.getAttribute('data-symbol')!));

test.describe('watchlist upgrades', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, 'desktop sidebar');

  test('shows a summary row and a 1-month trend line for each stock', async ({ page }) => {
    await open(page);
    const wl = watchlist(page);
    await expect(wl.getByLabel(/^Today: \d+ up, \d+ down, \d+ unchanged$/)).toBeVisible();
    const rows = await wlSymbols(page);
    expect(rows.length).toBeGreaterThan(3);
    await expect(wl.getByRole('img', { name: /^1-month trend [+−±]/ })).toHaveCount(rows.length);
    if (SHOTS) await wl.screenshot({ path: `${SHOTS}/p8-watchlist.png` });
  });

  test('sorting by name is applied and remembered', async ({ page }) => {
    await open(page);
    await watchlist(page).getByLabel('Sort').selectOption('name');
    const sorted = await wlSymbols(page);
    expect(sorted).toEqual([...sorted].sort());
    await page.reload();
    await expect(watchlist(page).getByLabel('Sort')).toHaveValue('name');
    await watchlist(page).getByLabel('Sort').selectOption('manual');
  });

  test('reorder with the keyboard and by dragging; the order is saved', async ({ page, request }) => {
    await open(page);
    const before = await wlSymbols(page);
    const wl = watchlist(page);
    await wl.getByRole('button', { name: 'Edit order' }).click();
    // keyboard: move the 2nd stock up
    await wl.getByRole('button', { name: `Move ${before[1]}` }).focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByText(`${before[1]} moved to position 1 of`)).toBeAttached();
    await expect.poll(() => wlSymbols(page)).toEqual([before[1], before[0], ...before.slice(2)]);
    // drag: the 4th stock to the top
    const handle = wl.getByRole('button', { name: `Move ${before[3]}` });
    const top = (await wl.locator('li').first().boundingBox())!;
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, top.y + 4, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => wlSymbols(page)).toEqual([before[3], before[1], before[0], before[2], ...before.slice(4)]);
    if (SHOTS) await wl.screenshot({ path: `${SHOTS}/p8-edit-order.png` });
    await wl.getByRole('button', { name: 'Done' }).click();
    // saved on the server
    await page.reload();
    await expect.poll(() => wlSymbols(page)).toEqual([before[3], before[1], before[0], before[2], ...before.slice(4)]);
    await request.put(`${API}/watchlist/order`, { data: { symbols: before } }); // restore
  });

  test('groups: create, collapse, and remove from group', async ({ page }) => {
    await open(page);
    const wl = watchlist(page);
    const [first, second] = await wlSymbols(page);
    for (const s of [first, second]) {
      await wl.getByRole('button', { name: `More actions for ${s}` }).click();
      const menu = page.getByRole('dialog', { name: `More actions for ${s}` });
      if (s === first) {
        await menu.getByLabel('New group name').fill('Tech');
        await menu.getByRole('button', { name: 'Add', exact: true }).click();
      } else {
        await menu.getByRole('button', { name: 'Tech' }).click();
      }
    }
    const header = wl.getByRole('button', { name: /^Tech 2/ });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(wl.getByRole('button', { name: /^No group/ })).toBeVisible();
    if (SHOTS) await wl.screenshot({ path: `${SHOTS}/p8-groups.png` });
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(wl.getByRole('link', { name: new RegExp(`^${first}`) })).toHaveCount(0);
    await header.click();
    for (const s of [first, second]) {
      await wl.getByRole('button', { name: `More actions for ${s}` }).click();
      await page.getByRole('dialog', { name: `More actions for ${s}` }).getByRole('button', { name: 'Remove from group' }).click();
    }
    await expect(wl.getByRole('button', { name: /^Tech/ })).toHaveCount(0);
  });
});

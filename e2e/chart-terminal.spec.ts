import { expect, test, type Page } from '@playwright/test';

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 1024;

async function openStock(page: Page, symbol = 'AAPL') {
  await page.goto(`/stock/${symbol}`);
  await expect(page.locator('#price-title')).toHaveText(symbol);
  await expect(page.locator('div[role=img][aria-label^="Price chart"]')).toBeVisible();
}

test.describe('ECharts Trading Terminal', () => {
  test('renders chart canvas, toolbar and responsive elements', async ({ page }) => {
    await openStock(page);

    // Verify main chart canvas exists
    const chart = page.locator('div[role=img][aria-label^="Price chart"]');
    await expect(chart).toBeVisible();

    // Verify toolbar controls
    const styleGroup = page.locator('div[role=group][aria-label="Chart style"]');
    await expect(styleGroup.getByRole('button', { name: 'Candles' })).toBeVisible();
    await expect(styleGroup.getByRole('button', { name: 'Line' })).toBeVisible();
    await expect(styleGroup.getByRole('button', { name: 'Area' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Indicators' })).toBeVisible();
    await expect(page.getByTitle('Reset Zoom / Fit Data')).toBeVisible();
    await expect(page.getByTitle('Export PNG')).toBeVisible();
    await expect(page.getByTitle('Fullscreen')).toBeVisible();
  });

  test('switches chart types among Candles, Line, and Area', async ({ page }) => {
    await openStock(page);

    const styleGroup = page.locator('div[role=group][aria-label="Chart style"]');
    const candlesBtn = styleGroup.getByRole('button', { name: 'Candles' });
    const lineBtn = styleGroup.getByRole('button', { name: 'Line' });
    const areaBtn = styleGroup.getByRole('button', { name: 'Area' });

    await lineBtn.click();
    await expect(lineBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(candlesBtn).toHaveAttribute('aria-pressed', 'false');

    await areaBtn.click();
    await expect(areaBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(lineBtn).toHaveAttribute('aria-pressed', 'false');

    await candlesBtn.click();
    await expect(candlesBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('crosshair hover displays OHLCV status tooltip', async ({ page }) => {
    test.skip(isPhone(page), 'mouse hover');
    await openStock(page);

    const box = (await page.locator('div[role=img][aria-label^="Price chart"]').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4);

    const tip = page.getByRole('status').filter({ hasText: 'Volume' });
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Open');
    await expect(tip).toContainText('Close');
    await expect(tip).toContainText('Change');
  });

  test('toggles technical indicators overlays and sub-panels', async ({ page }) => {
    test.skip(isPhone(page), 'toolbar interaction');
    await openStock(page);

    const indBtn = page.getByRole('button', { name: 'Indicators' });
    await indBtn.click();

    // Toggle SMA 20 overlay
    const sma20Btn = page.getByRole('button', { name: 'SMA 20', exact: true });
    await expect(sma20Btn).toBeVisible();
    await sma20Btn.click();

    // Toggle RSI 14 sub-panel
    const rsiBtn = page.getByRole('button', { name: 'RSI 14', exact: true });
    await expect(rsiBtn).toBeVisible();
    await rsiBtn.click();

    // Indicator count badge should show 2
    await expect(indBtn.locator('span.rounded-full')).toHaveText('2');
  });

  test('adds and clears drawings on the chart', async ({ page }) => {
    test.skip(isPhone(page), 'drawings toolbar');
    await openStock(page);

    const drawBtn = page.getByRole('button', { name: 'Draw' });
    await drawBtn.click();

    const hLineBtn = page.getByRole('button', { name: 'Horizontal Line' });
    await expect(hLineBtn).toBeVisible();
    await hLineBtn.click();

    // Open draw menu again to clear
    await drawBtn.click();
    const clearBtn = page.getByRole('button', { name: 'Clear All' });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
  });

  test('captures screenshots comparing ECharts and fallback Lightweight renderer', async ({ page }) => {
    test.skip(isPhone(page), 'desktop visual comparison');
    await openStock(page);

    const chart = page.locator('div[role=img][aria-label^="Price chart"]');
    await page.waitForTimeout(500); // allow initial render to stabilize

    // Capture ECharts default screenshot
    await chart.screenshot({ path: 'e2e/screenshots/echarts-default.png' });

    // Switch to Lightweight Charts fallback via localStorage
    await page.evaluate(() => {
      localStorage.setItem('tm_chart_engine', 'lightweight');
    });
    await page.reload();
    await expect(page.locator('div[role=img][aria-label^="Price chart"]')).toBeVisible();
    await page.waitForTimeout(500);

    // Capture Lightweight Charts screenshot
    await page.locator('div[role=img][aria-label^="Price chart"]').screenshot({
      path: 'e2e/screenshots/lightweight-fallback.png',
    });

    // Restore ECharts default
    await page.evaluate(() => {
      localStorage.removeItem('tm_chart_engine');
    });
  });
});

import { expect, test, type Page } from '@playwright/test';

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 1024;
const API_PORT = process.env.PW_API_PORT ?? '4900';
const API = process.env.PW_API_URL ? `${process.env.PW_API_URL.replace(/\/$/, '')}/api` : `http://localhost:${API_PORT}/api`;

test.describe('Investment Research Agent E2E Acceptance', () => {
  test('renders ResearchReportCard with all tabs and interactive controls in Ask AI panel', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // 1. Open stock page
    await page.goto('/stock/AAPL');
    await expect(page.locator('#price-title')).toHaveText('AAPL');

    // 2. Open Ask AI panel
    const askAiBtn = page.locator('button[title^="Ask AI"]').first();
    await expect(askAiBtn).toBeVisible();
    await askAiBtn.click();

    // 3. Verify dialog opened
    const dialog = page.getByRole('dialog', { name: /ask ai/i });
    await expect(dialog).toBeVisible();

    // 4. Verify research suggestion pills are present
    const dcfPill = dialog.getByRole('button', { name: /run dcf valuation/i });
    await expect(dcfPill).toBeVisible();

    // 5. Click DCF suggestion pill to trigger research
    await dcfPill.click();

    // 6. Verify thinking state appears then completes with ResearchReportCard
    const reportCard = dialog.locator('div', { hasText: 'Valuation' }).filter({ hasText: 'Fundamentals' }).first();
    await expect(reportCard).toBeVisible({ timeout: 25_000 });

    // 7. Verify Valuation Tab (default active tab)
    await expect(dialog.getByText(/Attractive Under Assumptions/i)).toBeVisible();
    await expect(dialog.getByText('Bull Case').first()).toBeVisible();
    await expect(dialog.getByText('Base Case').first()).toBeVisible();
    await expect(dialog.getByText('Bear Case').first()).toBeVisible();

    // 8. Click Fundamentals Tab
    const fundTab = dialog.getByRole('button', { name: 'Fundamentals' });
    await fundTab.click();
    await expect(dialog.getByText('Rev YoY Growth')).toBeVisible();
    await expect(dialog.getByText('Net Margin')).toBeVisible();
    await expect(dialog.getByText('ROE')).toBeVisible();

    // 9. Click Technicals Tab
    const techTab = dialog.getByRole('button', { name: 'Technicals' });
    await techTab.click();
    await expect(dialog.getByText('Trend', { exact: true })).toBeVisible();
    await expect(dialog.getByText('RSI (14)')).toBeVisible();

    // 10. Click Risk & Thesis Tab
    const riskTab = dialog.getByRole('button', { name: /risk & thesis/i });
    await riskTab.click();
    await expect(dialog.getByText(/Risk Rating/i)).toBeVisible();
    await expect(dialog.getByText(/Thesis Invalidation Criteria/i)).toBeVisible();

    // 11. Test Tool Execution Stepper toggle inside ResearchReportCard
    const viewToolsBtn = reportCard.getByRole('button', { name: /view tools/i });
    await expect(viewToolsBtn).toBeVisible();
    await viewToolsBtn.click();
    await expect(reportCard.getByText('get_quote', { exact: true })).toBeVisible();
    await expect(reportCard.getByText('calculate_valuation', { exact: true })).toBeVisible();

    // Collapse tools
    const hideToolsBtn = reportCard.getByRole('button', { name: /hide/i });
    await hideToolsBtn.click();
    await expect(reportCard.getByText('get_quote', { exact: true })).not.toBeVisible();

    // 12. Verify zero unhandled browser errors
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });

  test('portfolio REST endpoints and ledger isolation in browser context', async ({ request }) => {
    // 1. Fetch investment profile
    const profileRes = await request.get(`${API}/portfolio/profile`);
    expect(profileRes.status()).toBe(200);
    const profile = await profileRes.json();
    expect(profile).toHaveProperty('horizon');
    expect(profile).toHaveProperty('riskTolerance');

    // 2. Create portfolio
    const createRes = await request.post(`${API}/portfolio`, {
      data: { name: 'E2E Test Portfolio', currency: 'USD' },
    });
    expect(createRes.status()).toBe(201);
    const p = await createRes.json();
    expect(p.name).toBe('E2E Test Portfolio');

    // 3. Add cash deposit
    const depositRes = await request.post(`${API}/portfolio/${p.id}/transactions`, {
      data: { type: 'CASH_DEPOSIT', price: 25000, notes: 'Browser test deposit' },
    });
    expect(depositRes.status()).toBe(201);

    // 4. Add Buy AAPL
    const buyRes = await request.post(`${API}/portfolio/${p.id}/transactions`, {
      data: { symbol: 'AAPL', type: 'BUY', quantity: 20, price: 150, fee: 1 },
    });
    expect(buyRes.status()).toBe(201);

    // 5. Fetch portfolio summary
    const summaryRes = await request.get(`${API}/portfolio/${p.id}`);
    expect(summaryRes.status()).toBe(200);
    const summary = await summaryRes.json();
    expect(summary.totalValue).toBeGreaterThan(0);
    expect(summary.cashBalance).toBe(25000 - 3001); // 21,999
    expect(summary.holdings.length).toBe(1);
    expect(summary.holdings[0].symbol).toBe('AAPL');

    // 6. Test rebalancing endpoint
    const rebalRes = await request.post(`${API}/portfolio/${p.id}/rebalance`, {
      data: {
        targets: [{ symbol: 'AAPL', targetWeight: 0.5 }],
      },
    });
    expect(rebalRes.status()).toBe(200);
    const rebal = await rebalRes.json();
    expect(rebal.actions).toBeDefined();

    // 7. Clean up
    const delRes = await request.delete(`${API}/portfolio/${p.id}`);
    expect(delRes.status()).toBe(200);
  });

  test('streams response with markdown formatting and supports new chat reset', async ({ page }) => {
    // 1. Open stock page
    await page.goto('/stock/AAPL');
    const askAiBtn = page.locator('button[title^="Ask AI"]').first();
    await askAiBtn.click();

    const dialog = page.getByRole('dialog', { name: /ask ai/i });
    await expect(dialog).toBeVisible();

    // 2. Type question into input box
    const input = dialog.locator('#ask-ai-input');
    await input.fill('What are the key resistance levels?');
    await dialog.locator('button[aria-label="Send question"]').click();

    // 3. Verify assistant message arrives and displays tool execution pills
    await expect(dialog.getByText('tools executed:').first()).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('get_quote (15ms)')).toBeVisible();

    // 4. Verify research report card renders
    await expect(dialog.getByText(/Quantitative research report/i)).toBeVisible();

    // 5. Test New Chat button resets the chat history cleanly
    const newChatBtn = dialog.getByRole('button', { name: /new chat/i });
    await newChatBtn.click();
    await expect(dialog.getByText('tools executed:')).not.toBeVisible();
    await expect(dialog.getByText('Ask anything about AAPL')).toBeVisible();
  });
});

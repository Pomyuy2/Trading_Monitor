import { expect, test } from '@playwright/test';

test.describe('Global Investment AI Chat E2E', () => {
  test('opens global AI chat from Header without symbol and asks general investment question', async ({ page }) => {
    await page.goto('/stock/AAPL');

    // 1. Click global AI Chat button in Header navigation
    const globalChatBtn = page.locator('header').getByRole('button', { name: /ai chat/i });
    await expect(globalChatBtn).toBeVisible();
    await globalChatBtn.click();

    // 2. Verify dialog opened in Global context mode
    const dialog = page.getByRole('dialog', { name: /ask ai/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/global/i).first()).toBeVisible();

    // 3. Verify global suggestions are displayed
    await expect(dialog.getByText(/compare nvda/i)).toBeVisible();

    // 4. Ask general investment question without any symbol
    const input = dialog.getByPlaceholder(/ask anything/i);
    await expect(input).toBeVisible();
    await input.fill('What is DCF valuation?');
    await dialog.locator('button[type="submit"]').click();

    // 5. Verify response renders
    await expect(dialog.getByText(/Discounted Cash Flow \(DCF\)/i)).toBeVisible({ timeout: 20_000 });
  });

  test('compares NVDA and AMD in global mode without visiting either stock page', async ({ page }) => {
    await page.goto('/stock/AAPL');

    // Open global AI Chat
    await page.locator('header').getByRole('button', { name: /ai chat/i }).click();
    const dialog = page.getByRole('dialog', { name: /ask ai/i });
    await expect(dialog).toBeVisible();

    // Click "Compare NVDA and AMD" suggestion or type it
    const compareBtn = dialog.getByRole('button', { name: /compare nvda/i });
    if (await compareBtn.isVisible()) {
      await compareBtn.click();
    } else {
      const input = dialog.getByPlaceholder(/ask anything/i);
      await input.fill('Compare NVDA and AMD');
      await dialog.locator('button[type="submit"]').click();
    }

    // Verify comparative response is generated
    await expect(dialog.getByText(/Comparative research analysis between NVDA and AMD/i)).toBeVisible({ timeout: 20_000 });
  });

  test('opens stock-context chat from stock page and allows switching context', async ({ page }) => {
    await page.goto('/stock/NVDA');

    // Click stock-specific "Ask AI" in PriceHeader
    const stockAskAi = page.locator('.area-price button[title^="Ask AI"]').first();
    await expect(stockAskAi).toBeVisible();
    await stockAskAi.click();

    const dialog = page.getByRole('dialog', { name: /ask ai/i });
    await expect(dialog).toBeVisible();

    // Verify it opened with NVDA stock context
    await expect(dialog.getByText(/nvda/i).first()).toBeVisible();

    // Switch context to Global mode using context selector pill
    const globalPill = dialog.getByRole('button', { name: /^global$/i });
    await expect(globalPill).toBeVisible();
    await globalPill.click();

    // Verify placeholder updated to global
    await expect(dialog.getByPlaceholder(/ask anything/i)).toBeVisible();

    // Switch context to Portfolio mode
    const portfolioPill = dialog.getByRole('button', { name: /^portfolio$/i });
    await expect(portfolioPill).toBeVisible();
    await portfolioPill.click();

    // Verify portfolio suggestions or controls appear
    await expect(dialog.getByText(/portfolio/i).first()).toBeVisible();
  });

  test('persists conversation history, allows switching, and creating new chat', async ({ page }) => {
    await page.goto('/stock/AAPL');
    await page.locator('header').getByRole('button', { name: /ai chat/i }).click();

    const dialog = page.getByRole('dialog', { name: /ask ai/i });
    await expect(dialog).toBeVisible();

    // Ask first question
    const input = dialog.getByPlaceholder(/ask anything/i);
    await input.fill('What is DCF valuation?');
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog.getByText(/Discounted Cash Flow \(DCF\)/i)).toBeVisible({ timeout: 20_000 });

    // Click "New chat" button
    const newChatBtn = dialog.getByRole('button', { name: /new chat/i });
    await newChatBtn.click();

    // Message list should be cleared
    await expect(dialog.getByText(/Discounted Cash Flow \(DCF\)/i)).not.toBeVisible();

    // Click "History" button to open conversations drawer
    const historyBtn = dialog.getByRole('button', { name: /history/i });
    await historyBtn.click();

    // Verify the saved conversation appears in history
    const savedConv = dialog.getByText(/What is DCF/i).first();
    await expect(savedConv).toBeVisible();

    // Click the saved conversation to resume it
    await savedConv.click();

    // Verify previous message is restored
    await expect(dialog.getByText(/Discounted Cash Flow \(DCF\)/i)).toBeVisible();
  });

  test('mobile responsive navigation and chat view', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/stock/AAPL');

    // Global AI Chat button is visible in mobile header
    const aiChatMobile = page.locator('header').getByRole('button', { name: /ai chat/i });
    await expect(aiChatMobile).toBeVisible();
    await aiChatMobile.click();

    const dialog = page.getByRole('dialog', { name: /ask ai/i });
    await expect(dialog).toBeVisible();

    // Verify mobile back button is visible and closes panel
    const backBtn = dialog.getByRole('button', { name: /back/i });
    await expect(backBtn).toBeVisible();
    await backBtn.click();

    await expect(dialog).not.toBeVisible();
  });
});

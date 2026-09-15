import { test, expect } from './country-brief-fixtures';

test('anonymous Country Brief renders IMF indicators from public single-key reads', async ({ page, countryBrief }, testInfo) => {
  void countryBrief;
  const keys: string[] = [];
  const countries = { UA: { inflationPct: 4.2, realGdpGrowthPct: 2.3, unemploymentPct: 7.1, year: 2026 } };
  await page.route('**/api/bootstrap*', async route => {
    const url = new URL(route.request().url());
    const key = url.searchParams.get('keys');
    if (key?.startsWith('imf')) {
      expect(key).not.toContain(',');
      expect(url.searchParams.get('public')).toBe('1');
      keys.push(key);
      await route.fulfill({ json: { data: { [key]: { countries, seededAt: '2026-09-01T00:00:00Z' } } } });
    } else await route.fallback();
  });
  await page.goto('/dashboard?country=UA');
  const panel = page.locator('#country-deep-dive-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('navigation', { name: 'Country topics' }).getByRole('button', { name: 'Economy & trade', exact: true }).click();
  await expect(panel.getByText('CPI Inflation', { exact: true })).toBeVisible();
  await expect(panel.getByText('+4.2%', { exact: true })).toBeVisible();
  await expect(panel.getByText('+2.3%', { exact: true })).toBeVisible();
  await expect(panel.getByText('IMF WEO', { exact: true }).first()).toBeVisible();
  expect(new Set(keys)).toEqual(new Set(['imfMacro', 'imfGrowth', 'imfLabor', 'imfExternal']));
  await panel.getByText('CPI Inflation', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('imf-public-country-brief.png') });
});

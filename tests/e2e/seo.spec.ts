import { test, expect } from '@playwright/test';

test('serves crawl responses and real missing-page statuses from the production server', async ({
  request,
}) => {
  test.skip(process.env.EARRR_E2E_DEV === '1', 'This covers the built production server.');
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(robots.headers()['content-type']).toContain('text/plain');
  expect(await robots.text()).not.toContain('<!doctype html>');
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(404);
  expect(sitemap.headers()['x-robots-tag']).toBe('noindex');
  const missing = await request.get('/missing-seo-regression');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['x-robots-tag']).toBe('noindex');
  const callback = await request.get('/auth/callback');
  expect(callback.status()).toBe(200);
  expect(callback.headers()['x-robots-tag']).toBe('noindex');
  expect(await callback.text()).toContain('<title>Earrr');
  const homepage = await request.get('/');
  const asset = (await homepage.text()).match(/src="([^"]*\/assets\/[^"]+\.js)"/)![1]!;
  const script = await request.get(asset);
  expect(script.status()).toBe(200);
  expect(script.headers()['cache-control']).toContain('max-age=31536000');
  expect(script.headers()['cache-control']).toContain('immutable');
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const directory = resolve('frontend', 'public', 'brand');
const mark = readFileSync(resolve(directory, 'earrr-mark.svg'), 'utf8');
const wordmark = readFileSync(resolve(directory, 'earrr-wordmark.svg'), 'utf8');
const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [32, 48, 96, 128, 180, 192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>body{margin:0}img{display:block;width:100%;height:100%}</style><img alt="Earrr" src="${uri(mark)}">`,
    );
    await page
      .locator('img')
      .screenshot({ path: resolve(directory, `earrr-${size}.png`), omitBackground: true });
  }
  for (const width of [512, 1024]) {
    await page.setViewportSize({ width, height: 320 });
    await page.setContent(
      `<style>body{margin:0}img{display:block;width:${width}px;height:auto}</style><img alt="Earrr" src="${uri(wordmark)}">`,
    );
    await page
      .locator('img')
      .screenshot({
        path: resolve(directory, `earrr-wordmark-${width}.png`),
        omitBackground: true,
      });
  }
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(
    `<style>body{margin:0;background:oklch(97.5% .004 85);height:630px;display:grid;place-content:center;gap:26px;text-align:center;color:oklch(42% .015 350);font:26px system-ui}img{width:520px;display:block}p{margin:0}</style><img alt="Earrr" src="${uri(wordmark)}"><p>Ear training game with a friendly AI tutor.</p>`,
  );
  await page.screenshot({ path: resolve(directory, 'earrr-social.png') });
} finally {
  await browser.close();
}

import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteRoutes } from '../server/controllers/site.controller.js';
import { renderPublicHtml } from '../server/services/site.service.js';

const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const origin = 'https://earrr.app';

describe('public search metadata and crawl endpoints', () => {
  it('keeps the title and provides one canonical website identity with absolute social images', () => {
    const rendered = renderPublicHtml(html, origin);
    expect(rendered).toContain(
      '<title>Earrr | Ear training game with a friendly AI tutor.</title>',
    );
    expect(rendered.match(/rel="canonical"/g)).toHaveLength(1);
    expect(rendered).toContain('rel="canonical" href="https://earrr.app/"');
    expect(rendered).toContain('property="og:url" content="https://earrr.app/"');
    expect(rendered.match(/content="https:\/\/earrr\.app\/brand\/earrr-social\.png/g)).toHaveLength(
      2,
    );
    const structured = rendered.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )![1]!;
    expect(JSON.parse(structured)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Earrr',
      url: 'https://earrr.app/',
      inLanguage: 'en',
    });
    expect(structured).not.toMatch(/rating|review|offers|price/i);
    expect(renderPublicHtml(html)).toBe(html);
    expect(html).toContain('<noscript>');
    expect(html).toContain('Enable JavaScript');
    const description =
      'Simple, hands-free ear training with an AI tutor. Practice pitch, intervals and chords.';
    for (const field of ['description', 'og:description', 'twitter:description'])
      expect(rendered).toMatch(
        new RegExp(
          `(?:name|property)="${field}"\\s+content="${description.replaceAll('.', '\\.')}"`,
        ),
      );
    expect(rendered).not.toMatch(/while you work|through voice|clear feedback|guided lessons/i);
    expect(description).not.toMatch(/\bgame\b/i);
    expect(rendered).toContain('/brand/earrr-social.png?v=game-3');
  });

  it('serves a real text robots file without blocking resources used to render the app', async () => {
    const app = express().use(siteRoutes(origin));
    const response = await request(app).get('/robots.txt').expect(200);
    expect(response.type).toBe('text/plain');
    expect(response.text).toContain('User-agent: *\nAllow: /');
    expect(response.text).toContain('Disallow: /auth/');
    expect(response.text).toContain(`Sitemap: ${origin}/sitemap.xml`);
    expect(response.text).not.toMatch(/Disallow: \/(api|assets)|<!doctype/i);
  });

  it('restores the game headline consistently without changing the concise descriptions', () => {
    const title = 'Earrr | Ear training game with a friendly AI tutor.';
    const description =
      'Simple, hands-free ear training with an AI tutor. Practice pitch, intervals and chords.';
    const manifest = JSON.parse(
      readFileSync(new URL('../frontend/public/site.webmanifest', import.meta.url), 'utf8'),
    );
    expect(manifest.name).toBe(title);
    expect(manifest.description).toBe(description);
    for (const file of [
      '../scripts/build-brand.mjs',
      '../README.md',
      '../supabase/templates/confirmation.html',
      '../supabase/templates/recovery.html',
    ]) {
      const content = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(content, file).toContain('Ear training game with a friendly AI tutor.');
      expect(content, file).not.toMatch(/while you work|while doing other work/i);
    }
  });

  it('lists only the canonical homepage, without private lesson or authentication URLs', async () => {
    const response = await request(express().use(siteRoutes(origin)))
      .get('/sitemap.xml')
      .expect(200);
    expect(response.type).toBe('application/xml');
    expect(response.text).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(response.text.match(/<loc>/g)).toHaveLength(1);
    expect(response.text).toContain('<loc>https://earrr.app/</loc>');
    expect(response.text).not.toMatch(/auth|api|lesson/);
  });

  it('does not advertise a development sitemap and keeps the OAuth callback noindex', async () => {
    const local = express().use(siteRoutes());
    expect((await request(local).get('/robots.txt').expect(200)).text).toContain('Disallow: /');
    const missing = await request(local).get('/sitemap.xml').expect(404);
    expect(missing.headers['x-robots-tag']).toBe('noindex');
    const publicApp = express().use(siteRoutes(origin));
    publicApp.get('/auth/callback', (_req, res) =>
      res.type('html').send(renderPublicHtml(html, origin)),
    );
    const callback = await request(publicApp).get('/auth/callback').expect(200);
    expect(callback.headers['x-robots-tag']).toBe('noindex');
    expect(callback.text).toContain('<title>Earrr');
  });
});

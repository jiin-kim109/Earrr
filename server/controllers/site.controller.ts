import { Router } from 'express';

export function siteRoutes(publicOrigin?: string) {
  const router = Router();
  router.get('/robots.txt', (_req, res) => {
    res
      .type('text/plain')
      .send(
        publicOrigin
          ? `User-agent: *\nAllow: /\nDisallow: /auth/\nSitemap: ${publicOrigin}/sitemap.xml\n`
          : 'User-agent: *\nDisallow: /\n',
      );
  });
  router.get('/sitemap.xml', (_req, res) => {
    if (!publicOrigin)
      return res.status(404).set('X-Robots-Tag', 'noindex').type('text/plain').send('Not found.');
    res
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${publicOrigin}/</loc></url></urlset>\n`,
      );
  });
  router.use('/auth', (_req, res, next) => {
    res.set('X-Robots-Tag', 'noindex');
    next();
  });
  return router;
}

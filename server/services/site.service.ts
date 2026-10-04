export function renderPublicHtml(html: string, publicOrigin?: string) {
  if (!publicOrigin) return html;
  const url = `${publicOrigin}/`;
  const website = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Earrr',
    url,
    inLanguage: 'en',
  }).replaceAll('<', '\\u003c');
  return html
    .replaceAll('content="/brand/', `content="${publicOrigin}/brand/`)
    .replace(
      '</head>',
      `<link rel="canonical" href="${url}"><meta property="og:url" content="${url}"><script type="application/ld+json">${website}</script></head>`,
    );
}

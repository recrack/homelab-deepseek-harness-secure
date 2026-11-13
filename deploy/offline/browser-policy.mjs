/** Keep browser subresources on the DSH origin, including rendered web content. */
export default class LocalBrowserPolicy {
  static inject = ['webServer'];

  /** Register a disposable HTML policy transform with the Web host. */
  constructor(ctx) {
    ctx.effect(() => ctx.webServer.tapIndex(html => {
      const policy = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'";
      if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('Local browser policy requires an HTML head');
      return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off">`);
    }));
  }
}

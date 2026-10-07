export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = 'w.ocu.workers.dev';
    url.port = '';
    return Response.redirect(url, 308);
  },
};

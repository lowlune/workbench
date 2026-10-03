export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      url.port = '';
      return Response.redirect(url, 308);
    }
    return env.WORKBENCH.fetch(request);
  },
};

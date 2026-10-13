export default async (request, context) => {
  const url = new URL(request.url);
  if (url.hostname === 'teathetruth.com' || url.hostname === 'www.teathetruth.com') {
    // Serve Tea's own page directly; do not fetch the now-private CurtBrag host.
    return new URL('/teathetruth/index.html', request.url);
  }
};

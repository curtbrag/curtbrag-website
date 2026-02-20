export default async (request, context) => {
  const url = new URL(request.url);
  const host = url.hostname;

  if (host === "teathetruth.com" || host === "www.teathetruth.com") {
    // Rewrite path to serve Tea's page for all requests on this domain
    const rewriteUrl = new URL("/teathetruth/index.html", request.url);
    const newRequest = new Request(rewriteUrl, request);
    return context.next({ request: newRequest });
  }
};

export const config = {
  path: "/*",
};

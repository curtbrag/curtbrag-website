export default async (request, context) => {
  const url = new URL(request.url);
  const host = url.hostname;

  if (host === "teathetruth.com" || host === "www.teathetruth.com") {
    const teaUrl = new URL("/teathetruth/index.html", url.origin);
    return context.rewrite(teaUrl.toString());
  }

  return;
};

export const config = {
  path: "/*",
};

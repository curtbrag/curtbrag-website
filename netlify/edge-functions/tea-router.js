export default async (request, context) => {
  const url = new URL(request.url);
  const host = url.hostname;

  if (host === "teathetruth.com" || host === "www.teathetruth.com") {
    return context.rewrite("/teathetruth/index.html");
  }
};

export const config = {
  path: "/*",
};

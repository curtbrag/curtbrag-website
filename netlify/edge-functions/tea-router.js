export default async (request, context) => {
  const host = new URL(request.url).hostname;

  if (host === "teathetruth.com" || host === "www.teathetruth.com") {
    return context.rewrite("/teathetruth/index.html");
  }
};

export const config = {
  path: "/*",
};

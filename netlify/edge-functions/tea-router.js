export default async (request, context) => {
  const url = new URL(request.url);
  const host = url.hostname;

  if (host === "teathetruth.com" || host === "www.teathetruth.com") {
    const teaPage = new URL("/teathetruth/index.html", url.origin);
    const response = await fetch(teaPage.toString(), {
      headers: { "Host": "curtbrag.com" },
    });
    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  }
};

export const config = {
  path: "/*",
};

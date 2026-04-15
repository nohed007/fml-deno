// FML Deno Deploy — XHTTP transparent proxy to VPS2
// Last-resort fallback relay. Proxies XHTTP traffic to VPS2 where xray
// handles the VLESS protocol natively. No VLESS parsing in this handler.

const UPSTREAM = Deno.env.get("UPSTREAM") || "https://fml2.gsolution.ca";
const CF_WORKER = Deno.env.get("CF_WORKER") || "https://fml.gsolution.ca";

const INDEX_401_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>401 Unauthorized</title>
<style>
  html,body{height:100%;margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif;}
  .box{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;}
  h1{font-size:4rem;margin:0;}
  p{opacity:.7;}
</style>
</head>
<body>
  <div class="box">
    <h1>401</h1>
    <p>Unauthorized</p>
  </div>
</body>
</html>`;

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // API proxy — relay /vless-id and /ping to CF Worker (server-side, not
  // affected by GFW). Token validation and KV lookup stay in the Worker.
  if (url.pathname === "/vless-id" || url.pathname === "/ping") {
    const cfUrl = `${CF_WORKER}${url.pathname}${url.search}`;
    try {
      const resp = await fetch(cfUrl);
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "upstream unreachable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // XHTTP proxy — forward to VPS2
  if (url.pathname.startsWith("/fml-x")) {
    const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM);
    const headers = new Headers(req.headers);
    headers.set("Host", new URL(UPSTREAM).host);

    const upstreamResp = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: headers,
      body: req.body,
    });

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: upstreamResp.headers,
    });
  }

  return new Response(INDEX_401_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// No hostname/port — Deno Deploy injects them at runtime.
Deno.serve(handler);

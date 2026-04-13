// VLESS-over-WebSocket entry for Deno Deploy.
// Single-file handler using the modern Deno.serve() API so that the platform's
// Warm Up health check can bind to the auto-assigned port without our code
// hard-coding hostname/port (which previously caused Warm Up to time out).

const DEFAULT_UUID = "9a3b8c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const userID = (Deno.env.get("UUID") || DEFAULT_UUID).toLowerCase();

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

// Turn a 16-byte slice into the canonical UUID string (lowercase, hyphenated).
function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

// Parse the VLESS request header:
//   1B version | 16B UUID | 1B addonLen | M addon | 1B cmd | 2B port |
//   1B addrType | addr | payload
function parseVlessHeader(buf: ArrayBuffer): {
  version: number;
  addr: string;
  port: number;
  payload: Uint8Array;
} {
  if (buf.byteLength < 24) throw new Error("vless header too short");
  const view = new Uint8Array(buf);
  const version = view[0];
  const uuid = bytesToUuid(view.subarray(1, 17));
  if (uuid !== userID) throw new Error("invalid user");

  const addonLen = view[17];
  const cmdIdx = 18 + addonLen;
  const cmd = view[cmdIdx];
  if (cmd !== 1) throw new Error(`unsupported cmd ${cmd} (only TCP=1)`);

  const portIdx = cmdIdx + 1;
  const port = new DataView(buf).getUint16(portIdx, false);

  const addrTypeIdx = portIdx + 2;
  const addrType = view[addrTypeIdx];
  let addrIdx = addrTypeIdx + 1;
  let addr = "";
  let addrLen = 0;

  switch (addrType) {
    case 1: // IPv4
      addrLen = 4;
      addr = Array.from(view.subarray(addrIdx, addrIdx + 4)).join(".");
      break;
    case 2: // domain
      addrLen = view[addrIdx];
      addrIdx += 1;
      addr = new TextDecoder().decode(view.subarray(addrIdx, addrIdx + addrLen));
      break;
    case 3: { // IPv6
      addrLen = 16;
      const parts: string[] = [];
      for (let i = 0; i < 8; i++) {
        const hi = view[addrIdx + i * 2];
        const lo = view[addrIdx + i * 2 + 1];
        parts.push(((hi << 8) | lo).toString(16));
      }
      addr = parts.join(":");
      break;
    }
    default:
      throw new Error(`invalid addr type ${addrType}`);
  }
  if (!addr) throw new Error("empty addr");

  const payloadIdx = addrIdx + addrLen;
  const payload = view.subarray(payloadIdx);
  return { version, addr, port, payload };
}

function handleWebSocket(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.binaryType = "arraybuffer";

  let remote: Deno.TcpConn | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let headerHandled = false;
  let label = "?:?";

  socket.onmessage = async (ev) => {
    try {
      if (!(ev.data instanceof ArrayBuffer)) return;

      if (headerHandled) {
        if (writer) await writer.write(new Uint8Array(ev.data));
        return;
      }
      headerHandled = true;

      const { version, addr, port, payload } = parseVlessHeader(ev.data);
      label = `${addr}:${port}`;
      console.log(`[${label}] connecting`);

      remote = await Deno.connect({ hostname: addr, port });
      writer = remote.writable.getWriter();
      if (payload.byteLength > 0) await writer.write(payload);

      // Send VLESS response header, then pipe remote -> ws.
      socket.send(new Uint8Array([version, 0]).buffer);
      remote.readable
        .pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              // Copy to a standalone ArrayBuffer; the raw chunk buffer may be
              // pooled/reused by Deno's IO layer.
              const out = new Uint8Array(chunk.byteLength);
              out.set(chunk);
              socket.send(out.buffer);
            },
          }),
        )
        .catch((err) => console.log(`[${label}] remote->ws pipe error`, err));
    } catch (err) {
      console.log(`[${label}] onmessage error`, err);
      try { socket.close(); } catch { /* ignore */ }
    }
  };

  socket.onclose = () => {
    console.log(`[${label}] ws closed`);
    try { writer?.releaseLock(); } catch { /* ignore */ }
    try { remote?.close(); } catch { /* ignore */ }
  };
  socket.onerror = (e) => console.log(`[${label}] ws error`, e);

  return response;
}

function handler(req: Request): Response | Promise<Response> {
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }
  return new Response(INDEX_401_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// IMPORTANT: no hostname/port — Deno Deploy injects them at runtime.
Deno.serve(handler);

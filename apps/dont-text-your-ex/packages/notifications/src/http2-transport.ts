import http2 from "node:http2";
import type { ApnsHttpTransport } from "./apns-client";

const MAX_RESPONSE_BYTES = 4_096;

export function createHttp2ApnsTransport(timeoutMs = 8_000): ApnsHttpTransport {
  return (request) =>
    new Promise((resolve, reject) => {
      const session = http2.connect(request.origin);
      let settled = false;
      const finish = (error?: Error, value?: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        session.close();
        if (error) reject(error);
        else if (value) resolve(value);
      };
      session.on("error", (error) => finish(error));
      const stream = session.request({
        ":method": "POST",
        ":path": request.path,
        ...request.headers,
      });
      stream.setTimeout(timeoutMs, () => {
        stream.destroy();
        finish(new Error("APNs request timed out"));
      });
      stream.on("error", (error) => finish(error));
      let status = 0;
      let headers: Record<string, string | undefined> = {};
      stream.on("response", (responseHeaders) => {
        status = Number(responseHeaders[":status"] ?? 0);
        headers = {
          "apns-id": String(responseHeaders["apns-id"] ?? "") || undefined,
          "retry-after": String(responseHeaders["retry-after"] ?? "") || undefined,
        };
      });
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (body.length < MAX_RESPONSE_BYTES)
          body += chunk.slice(0, MAX_RESPONSE_BYTES - body.length);
      });
      stream.on("end", () => finish(undefined, { status, headers, body }));
      stream.end(request.body);
    });
}

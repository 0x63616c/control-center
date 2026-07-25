import { defineHttp } from "@app-kit";
import { openCameraStream } from "./service";

/**
 * Live camera MJPEG proxy (Track C fold , moved off the hardcoded server.ts
 * ladder onto the S3 route table). go2rtc holds the RTSP credentials and
 * transcodes the bedroom stream to MJPEG; the panel just consumes this
 * same-origin path in an <img>. The body is a long-lived multipart stream, so
 * it is piped through verbatim and MUST NOT be cached (a max-age here would
 * freeze the feed on the first frame) and MUST NOT carry any request timeout.
 * CORS is overlaid centrally by server.ts's route-table iterator; do NOT set
 * it here (mirrors features/wakes/http.ts).
 */
export const routes = defineHttp([
  {
    method: "GET",
    path: "/media/camera-stream",
    match: "exact",
    handler: async () => {
      const upstream = await openCameraStream();
      if (!upstream) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type":
            upstream.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=frame",
          "Cache-Control": "no-store",
        },
      });
    },
  },
]);

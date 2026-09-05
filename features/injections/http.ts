import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineHttp } from "@app-kit";
import { getLogger } from "@www/logger";
import { genId } from "@www/platform";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { config, db } from "./db";
import { POSES } from "./model";
import { injectionCourse, injectionPhoto } from "./schema";

const metaInput = z.object({
  courseId: z.string().regex(/^icr_[a-zA-Z0-9-]+$/),
  at: z.iso.datetime({ offset: true }),
  pose: z.enum(POSES),
  notes: z.string().max(10000),
  weightId: z.string().max(100).nullable(),
});
const root = () => join(config.MEDIA_STORAGE_DIR ?? "/data/media", "progress-photos");
const MAX_BYTES = 8 * 1024 * 1024;
export const routes = defineHttp([
  {
    method: "POST",
    path: "/media/progress-photo",
    match: "exact",
    handler: async (req) => {
      let meta: unknown;
      try {
        meta = JSON.parse(decodeURIComponent(req.headers.get("x-photo-meta") ?? "null"));
      } catch {
        return new Response("Invalid photo metadata", { status: 400 });
      }
      const parsed = metaInput.safeParse(meta);
      if (!parsed.success) return new Response("Invalid photo metadata", { status: 400 });
      const [course] = await db
        .select({ id: injectionCourse.id })
        .from(injectionCourse)
        .where(eq(injectionCourse.id, parsed.data.courseId));
      if (!course) return new Response("Course not found", { status: 404 });
      if (Number(req.headers.get("content-length")) > MAX_BYTES)
        return new Response("Photo too large", { status: 413 });
      const reader = req.body?.getReader();
      if (!reader) return new Response("Photo required", { status: 400 });
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > MAX_BYTES) {
          await reader.cancel();
          return new Response("Photo too large", { status: 413 });
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.length;
      }
      if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255)
        return new Response("JPEG required", { status: 400 });
      const id = genId("iph");
      await mkdir(root(), { recursive: true });
      await writeFile(join(root(), `${id}.jpg`), bytes, { flag: "wx" });
      await db.insert(injectionPhoto).values({ id, ...parsed.data });
      getLogger().info({ id, bytes: length }, "progress photo stored");
      return Response.json({ id }, { status: 201 });
    },
  },
  {
    method: "GET",
    path: "/media/progress-photos/",
    match: "prefix",
    handler: async (_req, url) => {
      const id = url.pathname.slice("/media/progress-photos/".length);
      if (!/^iph_[a-zA-Z0-9-]+$/.test(id)) return new Response("Not found", { status: 404 });
      const [row] = await db
        .select({ id: injectionPhoto.id })
        .from(injectionPhoto)
        .where(and(eq(injectionPhoto.id, id), isNull(injectionPhoto.deletedAt)));
      if (!row) return new Response("Not found", { status: 404 });
      try {
        const bytes = new Uint8Array(await readFile(join(root(), `${id}.jpg`)));
        return new Response(bytes, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  },
]);

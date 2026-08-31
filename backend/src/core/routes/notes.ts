import { handleSmartNotes } from "../../services/smartnotes";
import { emitToAll } from "../../utils/chat/ws";
import { withTimeout } from "../../utils/quiz/promise";
import { config } from "../../config/env";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import {
  completeLearningArtifact,
  createLearningArtifact,
  failLearningArtifact,
  getAuthorizedLearningArtifact,
  publicLearningArtifact,
  resolveAssistantTurnOrigin,
} from "../../learning/artifacts";

const ns = new Map<string, Set<any>>();
const nlog = (...a: any) => console.log("[smartnotes]", ...a);

export function smartnotesRoutes(app: any) {
  app.ws("/ws/smartnotes", async (ws: any, req: any) => {
    const u = new URL(req.url, "http://localhost");
    const id = u.searchParams.get("noteId");
    if (!id) return ws.close(1008, "noteId required");
    if (!await getAuthorizedLearningArtifact("notes", id, req.auth.subject)) {
      return ws.close(1008, "note not found");
    }

    let s = ns.get(id);
    if (!s) {
      s = new Set();
      ns.set(id, s);
    }
    s.add(ws);

    nlog("ws open", id, "clients:", s.size);
    ws.send(JSON.stringify({ type: "ready", noteId: id }));

    ws.on("error", (e: any) => nlog("ws err", id, e?.message || e));
    ws.on("close", () => {
      s!.delete(ws);
      if (s!.size === 0) ns.delete(id);
      nlog("ws close", id, "left:", s!.size);
    });

    const iv = setInterval(() => {
      try {
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      } catch {}
    }, 15000);
    ws.on("close", () => clearInterval(iv));
  });

  app.post("/smartnotes", async (req: any, res: any) => {
    try {
      const { topic, notes, filePath } = req.body || {};
      const origin = await resolveAssistantTurnOrigin(req.body, req.auth.subject);
      if ((req.body?.chatId || req.body?.assistantTurnId) && !origin) {
        return res.status(404).send({ error: "not found" });
      }
      if (!origin && !topic && !notes && !filePath) {
        return res
          .status(400)
          .send({ ok: false, error: "Provide topic, notes, or filePath" });
      }

      const noteId = crypto.randomUUID();
      await createLearningArtifact(noteId, "notes", req.auth.subject, origin);
      nlog("start", noteId, "input:", { topic, notes, filePath });

      res
        .status(202)
        .send({ ok: true, noteId, stream: `/ws/smartnotes?noteId=${noteId}` });

      setImmediate(async () => {
        try {
          emitToAll(ns.get(noteId), { type: "phase", value: "generating" });
          const result = await withTimeout(
            handleSmartNotes(origin ? { notes: origin.material } : { topic, notes, filePath }),
            120000,
            "handleSmartNotes"
          );
          nlog("generated", noteId, result.file);
          await completeLearningArtifact("notes", noteId, { file: result.file });
          emitToAll(ns.get(noteId), {
            type: "file",
            file: `${config.url}/smartnotes/${noteId}/download`,
          });
          emitToAll(ns.get(noteId), { type: "done" });
          nlog("done", noteId);
        } catch (e: any) {
          await failLearningArtifact("notes", noteId, e);
          nlog("error", noteId, e?.message || e);
          emitToAll(ns.get(noteId), {
            type: "error",
            error: e?.message || "failed",
          });
        }
      });
    } catch (e: any) {
      nlog("500 route err", e?.message || e);
      res.status(500).send({ ok: false, error: e?.message || "internal" });
    }
  });

  app.get("/smartnotes/:noteId", async (req: any, res: any) => {
    const artifact = await getAuthorizedLearningArtifact("notes", req.params.noteId, req.auth.subject);
    if (!artifact) return res.status(404).send({ error: "not found" });
    res.status(artifact.status === "pending" ? 202 : artifact.status === "failed" ? 500 : 200)
      .send({ ok: artifact.status === "ready", artifact: publicLearningArtifact(artifact) });
  });

  app.get("/smartnotes/:noteId/download", async (req: any, res: any) => {
    const artifact = await getAuthorizedLearningArtifact("notes", req.params.noteId, req.auth.subject);
    if (!artifact?.file || artifact.status !== "ready") return res.status(404).send({ error: "not found" });
    const filename = path.basename(artifact.file);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    fs.createReadStream(artifact.file).on("error", () => {
      if (!res.headersSent) res.status(404).send({ error: "not found" });
      else res.destroy();
    }).pipe(res);
  });
}

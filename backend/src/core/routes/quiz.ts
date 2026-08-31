import { handleQuiz } from "../../services/quiz";
import { emitToAll } from "../../utils/chat/ws";
import { withTimeout } from "../../utils/quiz/promise";
import crypto from "crypto";
import {
  completeLearningArtifact,
  createLearningArtifact,
  failLearningArtifact,
  getAuthorizedLearningArtifact,
  publicLearningArtifact,
  resolveAssistantTurnOrigin,
} from "../../learning/artifacts";

const qs = new Map<string, Set<any>>();
const qlog = (...a: any) => console.log("[quiz]", ...a);

export function quizRoutes(app: any) {
  app.ws("/ws/quiz", async (ws: any, req: any) => {
    const u = new URL(req.url, "http://localhost");
    const id = u.searchParams.get("quizId");
    if (!id) return ws.close(1008, "quizId required");
    if (!await getAuthorizedLearningArtifact("quiz", id, req.auth.subject)) {
      return ws.close(1008, "quiz not found");
    }

    let s = qs.get(id);
    if (!s) {
      s = new Set();
      qs.set(id, s);
    }
    s.add(ws);

    qlog("ws open", id, "clients:", s.size);
    ws.send(JSON.stringify({ type: "ready", quizId: id }));

    ws.on("error", (e: any) => qlog("ws err", id, e?.message || e));
    ws.on("close", () => {
      s!.delete(ws);
      if (s!.size === 0) qs.delete(id);
      qlog("ws close", id, "left:", s!.size);
    });

    const iv = setInterval(() => {
      try {
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      } catch {}
    }, 15000);
    ws.on("close", () => clearInterval(iv));
  });

  app.post("/quiz", async (req: any, res: any) => {
    try {
      const origin = await resolveAssistantTurnOrigin(req.body, req.auth.subject);
      if ((req.body?.chatId || req.body?.assistantTurnId) && !origin) {
        return res.status(404).send({ error: "not found" });
      }
      const topic = String(origin?.material || req.body?.topic || "").trim();
      if (!topic)
        return res.status(400).send({ ok: false, error: "topic required" });

      const quizId = crypto.randomUUID();
      await createLearningArtifact(quizId, "quiz", req.auth.subject, origin);
      qlog("start", quizId, "topic:", topic);

      res
        .status(202)
        .send({ ok: true, quizId, stream: `/ws/quiz?quizId=${quizId}` });

      setImmediate(async () => {
        try {
          emitToAll(qs.get(quizId), { type: "phase", value: "generating" });
          const qz = await withTimeout(handleQuiz(topic), 60000, "handleQuiz");
          await completeLearningArtifact("quiz", quizId, { output: qz });
          qlog("generated", quizId, Array.isArray(qz) ? qz.length : "n/a");
          emitToAll(qs.get(quizId), { type: "quiz", quiz: qz });
          emitToAll(qs.get(quizId), { type: "done" });
          qlog("done", quizId);
        } catch (e: any) {
          await failLearningArtifact("quiz", quizId, e);
          qlog("error", quizId, e?.message || e);
          emitToAll(qs.get(quizId), {
            type: "error",
            error: e?.message || "failed",
          });
        }
      });
    } catch (e: any) {
      qlog("500 route err", e?.message || e);
      res.status(500).send({ ok: false, error: e?.message || "internal" });
    }
  });

  app.get("/quiz/:quizId", async (req: any, res: any) => {
    const artifact = await getAuthorizedLearningArtifact("quiz", req.params.quizId, req.auth.subject);
    if (!artifact) return res.status(404).send({ error: "not found" });
    res.status(artifact.status === "pending" ? 202 : artifact.status === "failed" ? 500 : 200)
      .send({ ok: artifact.status === "ready", artifact: publicLearningArtifact(artifact) });
  });
}

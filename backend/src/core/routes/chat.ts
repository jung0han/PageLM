import { handleAsk } from "../../lib/ai/ask";
import { parseMultipart, handleUpload } from "../../lib/parser/upload";
import {
  mkChat,
  getChat,
  addMsg,
  listChats,
  getMsgs,
  getSourceBag,
  setSourceBag,
  getPrivateAsset,
} from "../../utils/chat/chat";
import { canAccessSharedNamespace } from "../../shared/snapshot";
import { emitToAll } from "../../utils/chat/ws";
import fs from "fs";
import { allowedModelAliases, resolveModelAlias } from "../../utils/llm/llm";
import { config } from "../../config/env";

type UpFile = { path: string; filename: string; mimeType: string };

const chatSockets = new Map<string, Set<any>>();

export function chatRoutes(app: any) {
  app.ws("/ws/chat", async (ws: any, req: any) => {
    const url = new URL(req.url, "http://localhost");
    const chatId = url.searchParams.get("chatId");
    if (!chatId) {
      return ws.close(1008, "chatId required");
    }
    if (!await getChat(chatId, req.auth.subject)) {
      return ws.close(1008, "chat not found");
    }

    let set = chatSockets.get(chatId);
    if (!set) {
      set = new Set();
      chatSockets.set(chatId, set);
    }
    set.add(ws);

    ws.on("close", (code: number, reason: string) => {
      set!.delete(ws);
      if (set!.size === 0) chatSockets.delete(chatId);
    });

    ws.send(JSON.stringify({ type: "ready", chatId }));
  });

  app.post("/chat", async (req: any, res: any, next: any) => {
    const t0 = Date.now();
    try {
      const ct = String(req.headers["content-type"] || "");
      const isMp = ct.includes("multipart/form-data");

      let q = "";
      let chatId: string | undefined;
      let files: UpFile[] = [];
      let requestedModel: string | undefined;

      if (isMp) {
        const tMp = Date.now();
        const { q: mq, chatId: mcid, model, files: mf } = await parseMultipart(req, req.auth.subject);
        q = mq;
        chatId = mcid;
        files = mf || [];
        requestedModel = model;
        if (!q)
          return res.status(400).send({ error: "q required for file uploads" });
      } else {
        q = req.body?.q || "";
        chatId = req.body?.chatId;
        requestedModel = req.body?.model;
        if (!q) return res.status(400).send({ error: "q required" });
      }
      let modelAlias: string;
      try {
        modelAlias = resolveModelAlias(requestedModel);
      } catch {
        for (const file of files) await fs.promises.unlink(file.path).catch(() => undefined);
        return res.status(400).send({ error: "model alias is not allowed" });
      }

      let chat = chatId ? await getChat(chatId, req.auth.subject) : undefined;
      if (chatId && !chat) {
        for (const file of files) await fs.promises.unlink(file.path).catch(() => undefined);
        return res.status(404).send({ error: "not found" });
      }
      if (!chat) chat = await mkChat(q, req.auth.subject);
      const id = chat.id;
      const ns = `chat:${id}`;

      res
        .status(202)
        .send({ ok: true, chatId: id, stream: `/ws/chat?chatId=${id}` });
      (async () => {
        try {
          if (isMp) {
            emitToAll(chatSockets.get(id), {
              type: "phase",
              value: "upload_start",
            });
            const tUp = Date.now();
            for (const f of files) {
              emitToAll(chatSockets.get(id), {
                type: "file",
                filename: f.filename,
                mime: f.mimeType,
              });
              await handleUpload({
                filePath: f.path,
                filename: f.filename,
                contentType: f.mimeType,
                namespace: ns,
                chatId: id,
                ownerSubject: req.auth.subject,
              });
            }
            emitToAll(chatSockets.get(id), {
              type: "phase",
              value: "upload_done",
            });
          }

          const tUser = Date.now();
          await addMsg(id, req.auth.subject, { role: "user", content: q, at: Date.now() });
          emitToAll(chatSockets.get(id), {
            type: "phase",
            value: "generating",
          });

          let answer: any = "";

          const msgHistory = await getMsgs(id, req.auth.subject) || [];
          const relevantHistory = msgHistory.slice(-20);
          const sharedNamespaceIds = await getSourceBag(id, req.auth.subject) || [];

          answer = await handleAsk({
            q,
            namespace: ns,
            history: relevantHistory,
            ownerSubject: req.auth.subject,
            modelAlias,
            sharedNamespaceIds,
            organizationSubjects: req.auth.person.organizationSubjects || [],
          });

          await addMsg(id, req.auth.subject, {
            role: "assistant",
            content: answer,
            at: Date.now(),
          });
          emitToAll(chatSockets.get(id), { type: "answer", answer });
          emitToAll(chatSockets.get(id), { type: "done" });
        } catch (err: any) {
          console.error("[chat] processing failed", { chatId: id });
          emitToAll(chatSockets.get(id), { type: "error", error: "chat_processing_failed" });
        }
      })().catch(() => {
        console.error("[chat] runner failed", { chatId: id });
      });
    } catch (e: any) {
      console.error("[chat] request failed");
      next(e);
    }
  });

  app.get("/models", async (_req: any, res: any) => {
    res.send({ ok: true, defaultAlias: config.litellmDefaultModelAlias, aliases: allowedModelAliases() });
  });

  app.get("/chats/:id/assets/:assetId", async (req: any, res: any) => {
    const asset = await getPrivateAsset(req.params.id, req.auth.subject, req.params.assetId);
    if (!asset) return res.status(404).send({ error: "not found" });
    res.setHeader("Content-Type", asset.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
    fs.createReadStream(asset.path).on("error", () => {
      if (!res.headersSent) res.status(404).send({ error: "not found" });
      else res.destroy();
    }).pipe(res);
  });

  app.get("/chats", async (req: any, res: any) => {
    const t = Date.now();
    const chats = await listChats(req.auth.subject);
    res.send({ ok: true, chats });
  });

  app.get("/chats/:id", async (req: any, res: any) => {
    const t = Date.now();
    const id = req.params.id;
    const chat = await getChat(id, req.auth.subject);
    if (!chat) {
      return res.status(404).send({ error: "not found" });
    }
    const messages = await getMsgs(id, req.auth.subject);
    res.send({ ok: true, chat, messages });
  });

  app.get("/chats/:id/source-bag", async (req: any, res: any) => {
    const namespaceIds = await getSourceBag(req.params.id, req.auth.subject);
    if (!namespaceIds) return res.status(404).send({ error: "not found" });
    res.send({ ok: true, namespaceIds });
  });

  app.put("/chats/:id/source-bag", async (req: any, res: any) => {
    const namespaceIds = req.body?.namespaceIds;
    if (!Array.isArray(namespaceIds) || namespaceIds.some((id: unknown) => typeof id !== "string" || !id)) {
      return res.status(400).send({ error: "namespaceIds must be an array of IDs" });
    }
    for (const namespaceId of namespaceIds) {
      if (!await canAccessSharedNamespace(namespaceId, {
        subject: req.auth.subject,
        organizationSubjects: req.auth.person.organizationSubjects,
      })) {
        return res.status(404).send({ error: "not found" });
      }
    }
    const saved = await setSourceBag(req.params.id, req.auth.subject, [...new Set(namespaceIds)] as string[]);
    if (!saved) return res.status(404).send({ error: "not found" });
    res.send({ ok: true, namespaceIds: saved });
  });
}

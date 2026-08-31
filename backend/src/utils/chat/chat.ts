import { randomUUID } from "crypto";
import db from "../database/keyv";

export type ChatMeta = { id: string; title: string; at: number };
export type ChatMsg = { role: "user" | "assistant"; content: any; at: number };
type StoredChat = ChatMeta & { ownerSubject: string };

export async function mkChat(t: string, ownerSubject: string) {
  const id = randomUUID();
  const c: StoredChat = { id, title: t.slice(0, 60), at: Date.now(), ownerSubject };
  await db.set(`chat:${id}`, c);
  await db.set(`msgs:${id}`, [] as ChatMsg[]);
  const idx = ((await db.get(`chat:index:${ownerSubject}`)) as string[]) || [];
  idx.unshift(id);
  await db.set(`chat:index:${ownerSubject}`, idx.slice(0, 1000));
  return publicChat(c);
}

export async function getChat(id: string, ownerSubject: string) {
  const chat = await db.get(`chat:${id}`) as StoredChat | undefined;
  return chat?.ownerSubject === ownerSubject ? publicChat(chat) : undefined;
}

export async function addMsg(id: string, ownerSubject: string, m: ChatMsg) {
  const c = (await db.get(`chat:${id}`)) as StoredChat | undefined;
  if (!c || c.ownerSubject !== ownerSubject) return false;
  const a = ((await db.get(`msgs:${id}`)) as ChatMsg[]) || [];
  a.push(m);
  await db.set(`msgs:${id}`, a);
  c.at = Date.now();
  await db.set(`chat:${id}`, c);
  return true;
}

export async function listChats(ownerSubject: string, n = 50) {
  const idx = ((await db.get(`chat:index:${ownerSubject}`)) as string[]) || [];
  const out: ChatMeta[] = [];
  for (const id of idx.slice(0, n)) {
    const c = (await db.get(`chat:${id}`)) as StoredChat | undefined;
    if (c?.ownerSubject === ownerSubject) out.push(publicChat(c));
  }
  return out.sort((x, y) => y.at - x.at);
}

export async function getMsgs(id: string, ownerSubject: string) {
  if (!await getChat(id, ownerSubject)) return undefined;
  const a = ((await db.get(`msgs:${id}`)) as ChatMsg[]) || [];
  return a;
}

export async function getSourceBag(id: string, ownerSubject: string) {
  if (!await getChat(id, ownerSubject)) return undefined;
  return ((await db.get(`source-bag:${id}`)) as string[]) || [];
}

export async function setSourceBag(id: string, ownerSubject: string, namespaceIds: string[]) {
  if (!await getChat(id, ownerSubject)) return undefined;
  await db.set(`source-bag:${id}`, namespaceIds);
  return namespaceIds;
}

function publicChat(chat: StoredChat): ChatMeta {
  return { id: chat.id, title: chat.title, at: chat.at };
}

import db from "../utils/database/keyv"
import { getAssistantTurn } from "../utils/chat/chat"
import { canAccessSharedNamespace, type SharedNamespacePrincipal } from "../shared/snapshot"

export type LearningArtifactKind = "notes" | "flashcards" | "quiz" | "examlab" | "debate" | "podcast"
export type LearningArtifactStatus = "pending" | "ready" | "failed"

export type LearningArtifactOrigin = {
  chatId: string
  assistantTurnId: string
  sharedNamespaceIds: string[]
}

export type LearningArtifact = {
  id: string
  kind: LearningArtifactKind
  ownerSubject: string
  status: LearningArtifactStatus
  createdAt: number
  origin?: LearningArtifactOrigin
  output?: unknown
  file?: string
  error?: string
}

export type ResolvedAssistantTurn = LearningArtifactOrigin & { material: string }

function contentText(content: any) {
  if (typeof content === "string") return content
  if (typeof content?.answer === "string") return content.answer
  return JSON.stringify(content ?? "")
}

export async function resolveAssistantTurnOrigin(input: any, ownerSubject: string): Promise<ResolvedAssistantTurn | undefined> {
  const chatId = String(input?.chatId || "").trim()
  const assistantTurnId = String(input?.assistantTurnId || "").trim()
  if (!chatId && !assistantTurnId) return undefined
  if (!chatId || !assistantTurnId) throw new Error("chatId and assistantTurnId are required together")
  const turn = await getAssistantTurn(chatId, ownerSubject, assistantTurnId)
  if (!turn) return undefined
  return {
    chatId,
    assistantTurnId,
    sharedNamespaceIds: [...new Set(turn.sharedNamespaceIds || [])],
    material: contentText(turn.content),
  }
}

export async function createLearningArtifact(
  id: string,
  kind: LearningArtifactKind,
  ownerSubject: string,
  origin?: ResolvedAssistantTurn,
) {
  const artifact: LearningArtifact = {
    id,
    kind,
    ownerSubject,
    status: "pending",
    createdAt: Date.now(),
    origin: origin && {
      chatId: origin.chatId,
      assistantTurnId: origin.assistantTurnId,
      sharedNamespaceIds: origin.sharedNamespaceIds,
    },
  }
  await db.set(`learning-artifact:${kind}:${id}`, artifact)
  return artifact
}

export async function completeLearningArtifact(kind: LearningArtifactKind, id: string, update: { output?: unknown; file?: string }) {
  const artifact = await getLearningArtifact(kind, id)
  if (!artifact) return undefined
  Object.assign(artifact, update, { status: "ready" as const })
  await db.set(`learning-artifact:${kind}:${id}`, artifact)
  return artifact
}

export async function failLearningArtifact(kind: LearningArtifactKind, id: string, error: unknown) {
  const artifact = await getLearningArtifact(kind, id)
  if (!artifact) return undefined
  artifact.status = "failed"
  artifact.error = error instanceof Error ? error.message : String(error)
  await db.set(`learning-artifact:${kind}:${id}`, artifact)
  return artifact
}

export async function getLearningArtifact(kind: LearningArtifactKind, id: string) {
  return await db.get(`learning-artifact:${kind}:${id}`) as LearningArtifact | undefined
}

export async function getAuthorizedLearningArtifact(kind: LearningArtifactKind, id: string, principal: SharedNamespacePrincipal) {
  const artifact = await getLearningArtifact(kind, id)
  if (!artifact || artifact.ownerSubject !== principal.subject) return undefined
  for (const namespaceId of artifact.origin?.sharedNamespaceIds || []) {
    if (!await canAccessSharedNamespace(namespaceId, principal)) return undefined
  }
  return artifact
}

export function publicLearningArtifact(artifact: LearningArtifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    status: artifact.status,
    createdAt: artifact.createdAt,
    sharedNamespaceIds: artifact.origin?.sharedNamespaceIds || [],
    output: artifact.output,
    error: artifact.error,
  }
}

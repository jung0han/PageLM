import { GoogleAuth } from "google-auth-library"
import { config } from "../config/env"

export const EMBEDDING_MODEL = "gemini-embedding-001"
export const EMBEDDING_DIMENSIONS = 1536

type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"

export async function embedWithVertex(text: string, taskType: EmbeddingTask): Promise<number[]> {
  if (!config.vertexProjectId) throw new Error("VERTEX_PROJECT_ID is required")
  const base = config.vertexApiEndpoint || `https://${config.vertexLocation}-aiplatform.googleapis.com/v1`
  const url = `${base}/projects/${encodeURIComponent(config.vertexProjectId)}/locations/${encodeURIComponent(config.vertexLocation)}/publishers/google/models/${EMBEDDING_MODEL}:predict`
  const data = {
    instances: [{ content: text, task_type: taskType }],
    parameters: { outputDimensionality: EMBEDDING_DIMENSIONS },
  }
  let responseData: any
  if (config.vertexAccessToken) {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.vertexAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify(data),
    })
    if (!response.ok) throw new Error(`Vertex embedding request failed: ${response.status}`)
    responseData = await response.json()
  } else {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    const client = await auth.getClient()
    responseData = (await client.request<any>({ url, method: "POST", data })).data
  }
  const values = responseData?.predictions?.[0]?.embeddings?.values
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Vertex embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}`)
  }
  return values.map(Number)
}

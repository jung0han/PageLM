import { ChatOpenAI } from "@langchain/openai"
import { config } from "../../config/env"
import type { LLM, Msg } from "./models/types"

export function allowedModelAliases() {
  const aliases = config.litellmAllowedModelAliases.includes(config.litellmDefaultModelAlias)
    ? config.litellmAllowedModelAliases
    : [config.litellmDefaultModelAlias, ...config.litellmAllowedModelAliases]
  return [...new Set(aliases)]
}

export function resolveModelAlias(requested?: string) {
  const alias = requested?.trim() || config.litellmDefaultModelAlias
  if (!allowedModelAliases().includes(alias)) throw new Error("model alias is not allowed")
  return alias
}

export function generationForAlias(requested?: string): LLM {
  if (!config.litellmApiKey) throw new Error("LITELLM_API_KEY is required")
  const model = new ChatOpenAI({
    model: resolveModelAlias(requested),
    apiKey: config.litellmApiKey,
    temperature: config.temp,
    maxTokens: config.max_tokens,
    configuration: { baseURL: config.litellmBaseUrl },
  })
  return {
    invoke: (messages: Msg[]) => model.invoke(messages),
    call: (messages: Msg[]) => model.invoke(messages),
  }
}

const llm: LLM = {
  invoke: messages => generationForAlias().invoke(messages),
  call: messages => generationForAlias().call(messages),
}

export default llm

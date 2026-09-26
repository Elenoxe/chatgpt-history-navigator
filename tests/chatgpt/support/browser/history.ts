import {
  fetchAccessToken,
  fetchConversation,
  fetchConversationPage,
  ChatgptHttpError,
} from "../../../../src/platform/chatgpt/api"
import { getConversationContextSnapshot } from "../../../../src/platform/chatgpt/page"
import { ConversationDataError } from "../../../../src/platform/chatgpt/conversation"
import type { ConversationMessage } from "../../../../src/platform/chatgpt/conversation"
import { state, unavailable, skip } from "./state"

export function identity() {
  const [userId, conversationId] = JSON.parse(getConversationContextSnapshot()) as [
    string | null,
    string | null,
  ]
  if (!userId || !conversationId) unavailable("Page did not establish conversation identity")
  return { userId, conversationId }
}
export function messages(): ConversationMessage[] {
  if (!state.mapping && !state.firstPage)
    unavailable("No compatible history response; API checks are prerequisites")
  return state.mapping?.messages ?? state.firstPage?.messages ?? []
}
export function users() {
  return messages().filter((m) => m.role === "user" && !m.hidden)
}
export function populated() {
  if (!users().length) skip("Compatible API response contains no visible user messages")
  if (!document.querySelector("main")) unavailable("Conversation UI is not ready")
}
export function resourceContext() {
  return { ...identity(), projectId: location.pathname.match(/^\/g\/(g-p-[^/]+)/)?.[1] }
}

// Cache successful reads and failures: a dependent test must not retry an endpoint.
let session: ReturnType<typeof fetchAccessToken> | undefined
export function authenticate() {
  return (session ??= fetchAccessToken().then((token) => {
    state.token = token
    return token
  }))
}
let mappingRead: ReturnType<typeof fetchConversation> | undefined
export function mappingHistory() {
  return (mappingRead ??= authenticate()
    .then((token) => fetchConversation(identity().conversationId, { accessToken: token }))
    .then((value) => (state.mapping = value)))
}
let pageRead: ReturnType<typeof fetchConversationPage> | undefined
export function paginatedHistory() {
  return (pageRead ??= authenticate()
    .then((token) => fetchConversationPage(identity().conversationId, { accessToken: token }))
    .then((value) => (state.firstPage = value)))
}
export async function prepareHistory() {
  // Content tests need one sample, not two redundant endpoint reads.
  // Endpoint specs own compatibility failures; dependents explain why they are blocked.
  try {
    await mappingHistory()
  } catch (error) {
    if (error instanceof ConversationDataError || error instanceof ChatgptHttpError)
      unavailable(`Mapping history prerequisite failed: ${error.message}`)
    throw error
  }
}

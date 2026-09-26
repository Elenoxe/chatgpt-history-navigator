import "./network"
import * as history from "./history"
import * as navigation from "./navigation"
import * as resources from "./resources"
import * as state from "./state"
import { z } from "zod"
import { fetchConversationPage, fetchWritingContent } from "../../../../src/platform/chatgpt/api"
import { getConversationContextSnapshot } from "../../../../src/platform/chatgpt/page"
import { findLoader, findNavigation } from "../../../../src/platform/chatgpt/runtime"
import { writingBlocksSchema } from "../../../../src/platform/chatgpt/writing"
import { getPreviewContent, messageText } from "../../../../src/features/timeline/previewContent"

// Only browser-side adapter dependencies and shared operations; no test registry.
const browserApi = {
  ...history,
  ...navigation,
  ...resources,
  ...state,
  z,
  fetchConversationPage,
  fetchWritingContent,
  getConversationContextSnapshot,
  findLoader,
  findNavigation,
  writingBlocksSchema,
  getPreviewContent,
  messageText,
}
globalThis.chatgpt = browserApi
declare global {
  var chatgpt: typeof browserApi
}

import { createContext } from "react"
import type { PreviewResourceContext } from "@/platform/chatgpt/api"

// Captured by the conversation owner, never inferred by a file during a later navigation.
export const PreviewContext = createContext<PreviewResourceContext>({ userId: null })

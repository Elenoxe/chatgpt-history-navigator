import { findLoader, findNavigation } from "../../../../src/platform/chatgpt/runtime"
import { state, requireContract, absent, skip } from "./state"
import { populated, users, identity } from "./history"
export const pause = () =>
  new Promise<void>((resolve) => setTimeout(resolve, state.options.intervalMs))
export async function inViewport(id: string) {
  const deadline = performance.now() + state.options.actionTimeoutMs
  do {
    const element = document.querySelector<HTMLElement>(`main [data-turn-key="${CSS.escape(id)}"]`)
    const root = document.querySelector<HTMLElement>("main [data-app-action-timeline-scroll]")
    if (element && root) {
      const box = element.getBoundingClientRect(),
        clip = root.getBoundingClientRect()
      if (
        box.height > 0 &&
        box.bottom > Math.max(0, clip.top) &&
        box.top < Math.min(innerHeight, clip.bottom)
      )
        return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (performance.now() < deadline)
  throw new Error("Native call completed but target turn did not enter the scroll viewport")
}
export async function navigate(kind: "mounted" | "virtual" | "unloaded") {
  populated()
  const navigation = findNavigation()
  requireContract(navigation, "Native navigation discovery failed")
  const target = users().find((m) => {
    const mounted = !!document.querySelector(`main [data-turn-key="${CSS.escape(m.id)}"]`)
    const geometry = navigation.getEntryGeometry(m.id)
    return kind === "mounted"
      ? mounted
      : kind === "virtual"
        ? !mounted && !!geometry
        : !mounted && !geometry
  })
  if (!target) {
    const complete = state.mapping?.isHistoryComplete
    if (!complete)
      absent(`No ${kind} target in bounded history sample; remaining history was not scanned`)
    skip(`Complete API history has no ${kind} target in current host state`)
  }
  if (kind === "unloaded") {
    const loader = findLoader(identity().conversationId)
    requireContract(loader, "History loader discovery failed")
    await pause()
    await loader(AbortSignal.timeout(state.options.actionTimeoutMs))
    // Match the host commit boundary used by production revealQuestion.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  const current = findNavigation()
  requireContract(current, "Virtual-list API disappeared")
  // Production only uses geometry as an existence check, not its coordinates.
  requireContract(current.getEntryGeometry(target.id), "Missing target geometry")
  await pause()
  await current.scrollToKey(target.id, undefined, {
    align: "top",
    signal: AbortSignal.timeout(state.options.actionTimeoutMs),
  })
  await inViewport(target.id)
  return `${kind} target navigated using native API; no DOM fallback`
}

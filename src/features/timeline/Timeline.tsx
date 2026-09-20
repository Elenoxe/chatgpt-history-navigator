import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useTimeline } from "./useTimeline"
import { MessagePreview } from "./MessagePreview"
import { PreviewContext } from "./PreviewContext"
import { ScrollFade } from "./ScrollFade"
import "./timeline.css"

export default function Timeline() {
  const { t, i18n } = useTranslation()
  const timeline = useTimeline()
  const isVisible = !!timeline.conversationId && timeline.questions.length > 0
  const trackRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keepPreview = () => clearTimeout(closeTimer.current)
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  const interactingWithTrack = useRef(false)
  const followedQuestion = useRef<string | null>(null)
  const layout = useRef<{
    conversationId: string | null
    tops: Map<string, number>
    bottom: boolean
    overflow: boolean
  } | null>(null)
  const [preview, setPreview] = useState<{
    id: string
    conversationId: string | null
    anchor: HTMLElement
  } | null>(null)
  useLayoutEffect(() => {
    clearTimeout(closeTimer.current)
    setPreview(null)
    followedQuestion.current = null
    interactingWithTrack.current = false
  }, [timeline.conversationId])
  const question =
    preview?.conversationId === timeline.conversationId
      ? timeline.questions.find((question) => question.id === preview?.id)
      : undefined
  const showPreview = (id: string, element: HTMLElement) => {
    keepPreview()
    setPreview({ id, conversationId: timeline.conversationId, anchor: element })
  }
  const closePreview = () => {
    keepPreview()
    setPreview(null)
  }
  const scheduleClose = () => {
    keepPreview()
    closeTimer.current = setTimeout(() => {
      const card = previewRef.current
      if (
        card?.matches(":hover") ||
        card?.contains(
          card.getRootNode() instanceof ShadowRoot
            ? (card.getRootNode() as ShadowRoot).activeElement
            : document.activeElement,
        )
      )
        return
      setPreview(null)
    }, 200)
  }
  const questionIds = JSON.stringify(timeline.questions.map((question) => question.id))

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) {
      layout.current = null
      return
    }
    const previous = layout.current
    const ticks = [...track.querySelectorAll<HTMLElement>("[data-question-id]")]
    if (previous?.conversationId === timeline.conversationId) {
      const ids = [...previous.tops.keys()]
      const appended =
        ticks.length > ids.length &&
        ids.every((id, index) => ticks[index]?.dataset.questionId === id)
      if (previous.overflow) {
        if (appended && previous.bottom) track.scrollTop = track.scrollHeight
        else {
          const bounds = track.getBoundingClientRect()
          const anchor = ticks.find((tick) => {
            const top = previous.tops.get(tick.dataset.questionId!)
            return top !== undefined && top >= bounds.top && top < bounds.bottom
          })
          if (anchor)
            track.scrollTop +=
              anchor.getBoundingClientRect().top - previous.tops.get(anchor.dataset.questionId!)!
        }
      } else if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const duration = parseFloat(
          getComputedStyle(track).getPropertyValue("--timeline-animation-duration"),
        )
        for (const tick of ticks) {
          const top = previous.tops.get(tick.dataset.questionId!)
          if (top !== undefined) {
            const delta = top - tick.getBoundingClientRect().top
            if (delta)
              tick.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
                duration,
                easing: "ease-out",
              })
          }
        }
      }
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const duration = parseFloat(
          getComputedStyle(track).getPropertyValue("--timeline-animation-duration"),
        )
        for (const tick of ticks) {
          if (!previous.tops.has(tick.dataset.questionId!))
            tick.animate([{ opacity: 0 }, { opacity: 1 }], { duration })
        }
      }
    }
    const remember = () => {
      const top = track.getBoundingClientRect().top
      layout.current = {
        conversationId: timeline.conversationId,
        tops: new Map(
          ticks.map((tick) => [tick.dataset.questionId!, tick.offsetTop + top - track.scrollTop]),
        ),
        bottom: track.scrollHeight - track.clientHeight - track.scrollTop <= 1,
        overflow: track.scrollHeight > track.clientHeight,
      }
    }
    remember()
    track.addEventListener("scroll", remember, { passive: true })
    window.addEventListener("resize", remember)
    return () => {
      track.removeEventListener("scroll", remember)
      window.removeEventListener("resize", remember)
    }
  }, [questionIds, timeline.conversationId])

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const current = track.querySelector<HTMLElement>('[aria-current="true"]')
    if (!current) return
    const key = `${timeline.conversationId}:${current.dataset.questionId}`
    if (followedQuestion.current === key) return
    followedQuestion.current = key
    if (interactingWithTrack.current) return
    const bounds = track.getBoundingClientRect()
    const marker = current.getBoundingClientRect()
    const delta =
      marker.top < bounds.top
        ? marker.top - bounds.top
        : marker.bottom > bounds.bottom
          ? marker.bottom - bounds.bottom
          : 0
    if (delta)
      track.scrollBy({
        top: delta,
        behavior:
          Math.abs(delta) < track.clientHeight &&
          !matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "smooth"
            : "instant",
      })
  }, [timeline.visibleQuestionIds, timeline.conversationId])

  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const updateEdges = () => {
      const remaining = Math.max(0, track.scrollHeight - track.clientHeight - track.scrollTop)
      track.style.setProperty("--timeline-scroll-top", `${Math.max(0, track.scrollTop)}px`)
      track.style.setProperty("--timeline-scroll-bottom", `${remaining}px`)
    }
    updateEdges()
    const observer = new ResizeObserver(updateEdges)
    observer.observe(track)
    // Observe content height too, including changes to themed marker spacing.
    for (const child of track.children) observer.observe(child)
    track.addEventListener("scroll", updateEdges, { passive: true })
    return () => {
      observer.disconnect()
      track.removeEventListener("scroll", updateEdges)
    }
  }, [timeline.conversationId, timeline.questions])

  useLayoutEffect(() => {
    const card = previewRef.current
    if (!card || !preview || !question) return
    const updatePosition = () => {
      const rect = preview.anchor.getBoundingClientRect()
      card.style.setProperty("--preview-anchor-center", `${rect.top + rect.height / 2}px`)
      card.style.setProperty("--preview-height", `${card.getBoundingClientRect().height}px`)
    }
    updatePosition()
    const observer = new ResizeObserver(updatePosition)
    observer.observe(card)
    // A changed rail height moves every marker because the rail is centered.
    const rail = preview.anchor.closest(".timeline")
    if (rail) observer.observe(rail)
    window.addEventListener("resize", updatePosition)
    const containWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return // Preserve browser zoom gestures.
      const target = event.target instanceof Element ? event.target : null
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      const scroller = target?.closest<HTMLElement>(
        horizontal ? ".preview-scroll, .katex-display" : ".preview-scroll",
      )
      const delta = horizontal ? event.deltaX || event.deltaY : event.deltaY
      const container = horizontal
        ? scroller
        : (scroller
            ?.closest(".preview-scroll-horizontal")
            ?.parentElement?.closest<HTMLElement>(".preview-scroll") ?? scroller)
      const position = horizontal ? container?.scrollLeft : container?.scrollTop
      const remaining = container
        ? horizontal
          ? container.scrollWidth - container.clientWidth - container.scrollLeft
          : container.scrollHeight - container.clientHeight - container.scrollTop
        : 0
      if (!container || (delta < 0 && (position ?? 0) <= 0) || (delta > 0 && remaining <= 1))
        event.preventDefault()
    }
    card.addEventListener("wheel", containWheel, { passive: false })
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", updatePosition)
      card.removeEventListener("wheel", containWheel)
    }
  }, [preview, question])

  if (!isVisible) return null

  return (
    <>
      <aside
        key={timeline.conversationId}
        className="timeline"
        aria-label={t("timeline.label")}
        lang={i18n.language}
        onPointerEnter={keepPreview}
        onPointerLeave={scheduleClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") closePreview()
        }}
      >
        <div
          className="timeline-track"
          ref={trackRef}
          onScroll={closePreview}
          onPointerEnter={() => {
            interactingWithTrack.current = true
          }}
          onPointerLeave={() => {
            interactingWithTrack.current = false
          }}
          onFocus={() => {
            interactingWithTrack.current = true
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              interactingWithTrack.current = false
          }}
        >
          {timeline.questions.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className="timeline-tick"
              data-question-id={item.id}
              data-preview={question?.id === item.id || undefined}
              data-pending={timeline.pendingQuestionId === item.id || undefined}
              aria-current={timeline.visibleQuestionIds.has(item.id) ? "true" : undefined}
              aria-label={`${index + 1}. ${item.text || t("timeline.nonTextMessage")}`}
              aria-describedby={question?.id === item.id ? "timeline-preview" : undefined}
              onPointerEnter={(event) => showPreview(item.id, event.currentTarget)}
              onFocus={(event) => showPreview(item.id, event.currentTarget)}
              onBlur={scheduleClose}
              onClick={(event) => {
                showPreview(item.id, event.currentTarget)
                void timeline.jumpToQuestion(item.id)
              }}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
      </aside>
      {question && preview && (
        <div
          key={`${timeline.conversationId}:${question.id}`}
          id="timeline-preview"
          role="dialog"
          aria-labelledby="timeline-preview-title"
          className="timeline-preview"
          lang={i18n.language}
          ref={previewRef}
          onPointerEnter={keepPreview}
          onPointerLeave={scheduleClose}
          onFocus={keepPreview}
          onBlur={scheduleClose}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              preview.anchor.focus()
              closePreview()
            }
          }}
        >
          <div id="timeline-preview-title" className="timeline-preview-title">
            <MessagePreview message={question.message} title />
          </div>
          {question.responses.length > 0 && (
            <ScrollFade label={t("timeline.preview.responsesRegionLabel")}>
              <div className="timeline-preview-body">
                {question.responses.map((message) => (
                  <div className="preview-message" key={message.id}>
                    <PreviewContext.Provider value={timeline.previewContext}>
                      <MessagePreview message={message} conversationId={timeline.conversationId} />
                    </PreviewContext.Provider>
                  </div>
                ))}
              </div>
            </ScrollFade>
          )}
        </div>
      )}
    </>
  )
}

import { useLayoutEffect, useRef, type ReactNode } from "react"

/** Native scrolling with edge masks; observe content too for streaming text and images. */
export function ScrollFade({
  children,
  horizontal = false,
  label,
}: {
  children: ReactNode
  horizontal?: boolean
  label: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current!
    const update = () => {
      const start = horizontal ? element.scrollLeft : element.scrollTop
      const remaining = horizontal
        ? element.scrollWidth - element.clientWidth - start
        : element.scrollHeight - element.clientHeight - start
      element.style.setProperty("--scroll-start", `${Math.max(0, start)}px`)
      element.style.setProperty("--scroll-end", `${Math.max(0, remaining)}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    element.addEventListener("scroll", update, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener("scroll", update)
    }
  }, [children, horizontal])
  return (
    <div
      ref={ref}
      className={`preview-scroll${horizontal ? " preview-scroll-horizontal" : ""}`}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      <div className="preview-scroll-content">{children}</div>
    </div>
  )
}

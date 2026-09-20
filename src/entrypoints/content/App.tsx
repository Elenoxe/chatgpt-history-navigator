import Timeline from "@/features/timeline/Timeline"
import { usePageLanguage } from "@/i18n"
import { ToastProvider } from "@/shared/Toast"

export default function App() {
  usePageLanguage()
  return (
    <ToastProvider>
      <Timeline />
    </ToastProvider>
  )
}

import Timeline from "@/features/timeline/Timeline"
import { usePageLanguage } from "@/i18n"
import { useTranslation } from "react-i18next"
import { Toaster } from "sonner"
import { useEffect, useState } from "react"
import { observeComposerOffset } from "@/platform/chatgpt/page"

export default function App() {
  usePageLanguage()
  const { t } = useTranslation()
  const [toastBottom, setToastBottom] = useState(24)
  useEffect(() => observeComposerOffset(setToastBottom), [])
  return (
    <>
      <Timeline />
      <Toaster
        className="extension-toaster"
        theme="system"
        position="bottom-center"
        offset={{ bottom: toastBottom }}
        mobileOffset={{ bottom: toastBottom, left: 16, right: 16 }}
        duration={4000}
        closeButton
        containerAriaLabel={t("notifications")}
        toastOptions={{ closeButtonAriaLabel: t("dismissNotification") }}
      />
    </>
  )
}

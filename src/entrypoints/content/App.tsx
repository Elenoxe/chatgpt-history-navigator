import Timeline from "@/features/timeline/Timeline";
import { usePageLanguage } from "@/i18n";

export default function App() {
  usePageLanguage();
  return <Timeline />;
}

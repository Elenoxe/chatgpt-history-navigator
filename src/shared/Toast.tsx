import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import './toast.css';

const ToastContext = createContext<((message: string) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toast, setToast] = useState<{ message: string } | null>(null);
  const [paused, setPaused] = useState(false);
  const showError = useCallback((message: string) => setToast({ message }), []);
  useEffect(() => {
    if (!toast || paused) return;
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }, [toast, paused]);
  return <ToastContext.Provider value={showError}>
    {children}
    <div className="extension-toast-region" role="alert" aria-atomic="true">
      {toast && <div className="extension-toast"
        onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span>{toast.message}</span>
        <button type="button" aria-label={t('dismissNotification')}
          onClick={() => { setToast(null); setPaused(false); }}>×</button>
      </div>}
    </div>
  </ToastContext.Provider>;
}

export function useErrorToast() {
  const showError = useContext(ToastContext);
  if (!showError) throw new Error('useErrorToast requires ToastProvider');
  return showError;
}

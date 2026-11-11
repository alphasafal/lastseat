import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (text, kind = 'info') => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, text, kind }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 5000);
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({ info: (text) => push(text, 'info'), error: (text) => push(text, 'error') }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Announced by screen readers without moving focus. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            <span>{toast.text}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)}>
              <span className="sr-only">Dismiss</span>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

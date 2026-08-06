"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

interface ConfirmContextValue {
  confirm: (message: string) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

// Replaces the browser's blocking window.confirm() for the highest-stakes
// actions in the app (placing/closing a real order, switching strategy
// version) -- same call shape (await confirm(message) -> boolean), but
// non-blocking and styled to match the rest of the dashboard instead of the
// browser's native dialog chrome.
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const resolver = useRef<((value: boolean) => void) | undefined>(undefined);

  const confirm = useCallback((msg: string) => {
    setMessage(msg);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  function respond(value: boolean) {
    setMessage(null);
    resolver.current?.(value);
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {message && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => respond(false)}>
          <div
            className="mx-4 max-w-md rounded-2xl border border-white/10 bg-surface p-5 shadow-glass backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="whitespace-pre-line text-sm text-gray-200">{message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => respond(false)}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={() => respond(true)}
                className="rounded-lg bg-bad/90 px-3 py-1.5 text-sm font-semibold text-white hover:bg-bad"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (message: string) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx.confirm;
}

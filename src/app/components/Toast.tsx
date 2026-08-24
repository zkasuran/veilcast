"use client";

import { useEffect, useState, useCallback } from "react";
import styles from "../uni.module.css";

export type ToastType = "success" | "error" | "info";

interface ToastItem {
    id: number;
    message: string;
    type: ToastType;
    exiting: boolean;
}

let nextId = 0;
const listeners = new Set<(toast: Omit<ToastItem, "id" | "exiting">) => void>();

/** Fire a toast from anywhere in the app (no context/provider needed). */
export function showToast(message: string, type: ToastType = "info") {
    listeners.forEach((listener) => listener({ message, type }));
}

const DURATION = 3500; // auto-dismiss after 3.5s
const EXIT_MS = 280; // exit animation duration

/**
 * Toast container — renders a stack of non-blocking notifications.
 * Mount once at the page root. Listens to `showToast()` calls globally.
 */
export default function ToastContainer() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, EXIT_MS);
    }, []);

    useEffect(() => {
        const handler = (toast: Omit<ToastItem, "id" | "exiting">) => {
            const id = nextId++;
            setToasts((prev) => [...prev, { ...toast, id, exiting: false }]);
            setTimeout(() => dismiss(id), DURATION);
        };
        listeners.add(handler);
        return () => { listeners.delete(handler); };
    }, [dismiss]);

    if (toasts.length === 0) return null;

    return (
        <div className={styles.toastContainer} aria-live="polite" aria-relevant="additions">
            {toasts.map((toast) => (
                <div
                    key={toast.id}
                    className={`${styles.toast} ${styles[`toast_${toast.type}`]} ${toast.exiting ? styles.toastExit : ""}`}
                    role="alert"
                >
                    <span className={styles.toastIcon}>
                        {toast.type === "success" ? "✓" : toast.type === "error" ? "✕" : "ℹ"}
                    </span>
                    <span className={styles.toastMessage}>{toast.message}</span>
                    <button
                        className={styles.toastDismiss}
                        onClick={() => dismiss(toast.id)}
                        aria-label="Dismiss"
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
}

/**
 * Open http(s) / mailto links in the system default browser or mail client (Tauri webview
 * does not navigate external URLs by default).
 */
import { openUrl } from "@tauri-apps/plugin-opener";

export async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Delegate clicks on external anchors so they open outside the app. Call once at startup. */
export function setupExternalLinkDelegation(root: Document | HTMLElement = document): void {
  root.addEventListener(
    "click",
    (ev: Event) => {
      if (!(ev instanceof MouseEvent) || ev.button !== 0) return;
      let el: EventTarget | null = ev.target;
      if (el instanceof Text) el = el.parentElement;
      if (!(el instanceof Element)) return;
      const a = el.closest("a[href]");
      if (!a || !(a instanceof HTMLAnchorElement)) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (!/^(https?:|mailto:)/i.test(href.trim())) return;
      ev.preventDefault();
      void openExternalUrl(a.href);
    },
    true
  );
}

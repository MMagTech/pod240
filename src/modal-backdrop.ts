import { dbgSession } from "./debug-session-log";

/**
 * Backdrop dismiss only when the same gesture started on the overlay.
 * Prevents closing when the user finishes a text-selection drag with mouseup on the dimmed area
 * (click target becomes the overlay though pointerdown was on an input).
 */
export function attachConfirmedBackdropDismiss(
  overlay: HTMLElement,
  onBackdrop: () => void,
  ctx: string
): () => void {
  let pointerDownOnBackdrop = false;

  const onPointerDownCapture = (e: PointerEvent) => {
    pointerDownOnBackdrop = e.target === overlay;
  };
  document.addEventListener("pointerdown", onPointerDownCapture, true);

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target !== overlay) return;
    if (!pointerDownOnBackdrop) {
      // #region agent log
      dbgSession("H2-suppressed", `${ctx}:backdrop`, "ignored (pointerdown not on backdrop)", {});
      // #endregion
      return;
    }
    // #region agent log
    dbgSession("H2", `${ctx}:backdrop`, "backdrop click → cancel", {
      pointerType: (e as PointerEvent & { pointerType?: string }).pointerType ?? "",
    });
    // #endregion
    onBackdrop();
  };
  overlay.addEventListener("click", onBackdropClick);

  return () => {
    document.removeEventListener("pointerdown", onPointerDownCapture, true);
    overlay.removeEventListener("click", onBackdropClick);
  };
}

/**
 * Backdrop dismiss only when the same gesture started on the overlay.
 * Prevents closing when the user finishes a text-selection drag with mouseup on the dimmed area
 * (click target becomes the overlay though pointerdown was on an input).
 */
export function attachConfirmedBackdropDismiss(
  overlay: HTMLElement,
  onBackdrop: () => void,
  _ctx: string
): () => void {
  let pointerDownOnBackdrop = false;

  const onPointerDownCapture = (e: PointerEvent) => {
    pointerDownOnBackdrop = e.target === overlay;
  };
  document.addEventListener("pointerdown", onPointerDownCapture, true);

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target !== overlay) return;
    if (!pointerDownOnBackdrop) {
      return;
    }
    onBackdrop();
  };
  overlay.addEventListener("click", onBackdropClick);

  return () => {
    document.removeEventListener("pointerdown", onPointerDownCapture, true);
    overlay.removeEventListener("click", onBackdropClick);
  };
}

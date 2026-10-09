import { useEffect } from 'react';

/* iOS keeps the layout viewport behind the software keyboard. Publish the
   visual viewport inset so the shell can keep its composer above the keys. */
export function useViewportInsets() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
      if (inset > 80) root.setAttribute('data-keyboard', '');
      else root.removeAttribute('data-keyboard');
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--keyboard-inset');
      root.removeAttribute('data-keyboard');
    };
  }, []);
}

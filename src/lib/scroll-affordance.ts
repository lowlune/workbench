/* Scrollbars stay out of the way until the user actually scrolls. A capture
   listener on window catches `scroll` from every descendant (the event does
   not bubble, but it does propagate in the capture phase), tags the host with
   `data-scrolling`, and clears it once the gesture settles. The CSS in
   workbench.css fades the thumb in and out. */

const timers = new WeakMap<Element, number>();

function isScrollbarHost(element: Element) {
  return element.classList.contains('wb-scroll') || element.classList.contains('wb-scrollbar');
}

export function installScrollAffordance() {
  window.addEventListener(
    'scroll',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !isScrollbarHost(target)) return;
      target.setAttribute('data-scrolling', '');
      const previous = timers.get(target);
      if (previous) window.clearTimeout(previous);
      timers.set(target, window.setTimeout(() => {
        target.removeAttribute('data-scrolling');
        timers.delete(target);
      }, 900));
    },
    true,
  );
}

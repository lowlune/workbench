export function followsLiveEdge(nearBottom, movedUp) {
  return nearBottom && !movedUp;
}

export function followsMessages(atBottom, preservingScroll) {
  return atBottom && !preservingScroll;
}

export function shouldLoadOlder(scrollTop, hasMore) {
  return hasMore && scrollTop <= 56;
}

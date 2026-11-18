const edgeScrollWidth = 28;
const edgeScrollStep = 8;

export function bindEditorColumnDrag(heading, scroller, moveColumn) {
  const monthHeader = heading.firstElementChild;
  let source;
  let marker;
  let pointer;
  let scrollFrame;

  function getViewport() {
    const frame = scroller.getBoundingClientRect();
    const month = monthHeader.getBoundingClientRect();
    const left = frame.left + scroller.clientLeft;
    const top = frame.top + scroller.clientTop;
    const right = left + scroller.clientWidth;
    return {
      left,
      right,
      stockLeft: Math.min(right, Math.max(left, month.right)),
      top: Math.max(top, month.top),
      bottom: Math.min(top + scroller.clientHeight, month.bottom),
    };
  }

  function isInViewport({ x, y }, viewport) {
    return x >= viewport.left && x < viewport.right && y >= viewport.top && y < viewport.bottom;
  }

  function getPlacement(point, viewport) {
    if (!isInViewport(point, viewport) || point.x < viewport.stockLeft) return;
    const hit = heading.ownerDocument.elementFromPoint(point.x, point.y);
    const header = hit?.closest('th[data-stock-id]');
    if (header?.parentElement !== heading || header === source) return;
    const bounds = header.getBoundingClientRect();
    return { header, after: point.x >= (bounds.left + bounds.right) / 2 };
  }

  function showPlacement(placement) {
    if (marker?.header === placement?.header && marker?.after === placement?.after) return;
    marker?.header.classList.remove('insert-column-before', 'insert-column-after');
    marker = placement;
    marker?.header.classList.add(marker.after ? 'insert-column-after' : 'insert-column-before');
  }

  function clearHover() {
    pointer = undefined;
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
    showPlacement(undefined);
    source?.classList.remove('is-column-dragging');
  }

  function endDrag() {
    clearHover();
    source = undefined;
  }

  function scrollAtEdge() {
    scrollFrame = undefined;
    if (!heading.isConnected) {
      endDrag();
      return;
    }
    const viewport = getViewport();
    if (!pointer || !isInViewport(pointer, viewport)) {
      clearHover();
      return;
    }

    const edge = Math.min(edgeScrollWidth, (viewport.right - viewport.stockLeft) / 2);
    if (edge <= 0) return;
    const oldLeft = scroller.scrollLeft;
    if (pointer.x < viewport.stockLeft + edge) scroller.scrollLeft -= edgeScrollStep;
    else if (pointer.x >= viewport.right - edge) scroller.scrollLeft += edgeScrollStep;
    if (scroller.scrollLeft === oldLeft) return;

    showPlacement(getPlacement(pointer, getViewport()));
    scrollFrame = requestAnimationFrame(scrollAtEdge);
  }

  heading.addEventListener('dragstart', ({ target, dataTransfer }) => {
    const handle = target.closest('.editor-column-name[draggable="true"]');
    const header = handle?.closest('th[data-stock-id]');
    if (!dataTransfer || header?.parentElement !== heading) return;

    endDrag();
    source = header;
    source.classList.add('is-column-dragging');
    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData('application/x-editor-stock-column', source.dataset.stockId);
  });

  heading.addEventListener('dragover', (event) => {
    if (!source) return;
    const point = { x: event.clientX, y: event.clientY };
    const viewport = getViewport();
    if (!isInViewport(point, viewport)) {
      clearHover();
      return;
    }

    pointer = point;
    source.classList.add('is-column-dragging');
    const placement = getPlacement(point, viewport);
    showPlacement(placement);
    if (placement) event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = placement ? 'move' : 'none';
    if (scrollFrame === undefined) scrollFrame = requestAnimationFrame(scrollAtEdge);
  });

  heading.addEventListener('dragleave', ({ relatedTarget, clientX, clientY }) => {
    if (!source) return;
    const next = relatedTarget ?? heading.ownerDocument.elementFromPoint(clientX, clientY);
    if (!next?.nodeType || !heading.contains(next)) clearHover();
  });

  heading.addEventListener('drop', (event) => {
    if (!source) return;
    const placement = getPlacement({ x: event.clientX, y: event.clientY }, getViewport());
    const sourceId = source.dataset.stockId;
    endDrag();
    if (!placement) return;

    event.preventDefault();
    moveColumn(sourceId, placement.header.dataset.stockId, placement.after);
  });

  heading.addEventListener('dragend', endDrag);
}

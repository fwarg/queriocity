import { useEffect, useState } from 'react'

/** An element's width in CSS pixels and its top edge in the viewport, kept current as the panel or
 *  window resizes. A callback ref, because the element may mount only after data has loaded.
 *  Width is rounded to 10px so a scrollbar appearing doesn't re-run a layout. */
export function useElementSize() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [size, setSize] = useState({ width: 0, top: 0, viewport: 0 })
  useEffect(() => {
    if (!el) return
    const measure = () => setSize({
      width: Math.round(el.getBoundingClientRect().width / 10) * 10,
      top: Math.round(el.getBoundingClientRect().top),
      viewport: window.innerHeight,
    })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [el])
  return { ref: setEl, ...size }
}

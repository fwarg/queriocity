/** Colours for groups — top-level tags or topics — biggest first; the rest share OTHER_COLOUR.
 *  The `--viz-*` variables in index.css, so each theme (E-ink included) picks its own. Shared so a
 *  topic has the same colour in the bubbles, the note map and the graph. */
export const GROUP_COLOURS = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--viz-${i})`)
export const OTHER_COLOUR = 'var(--viz-other)'
/** Whatever is not the point of the current view: other topics, notes in no topic. */
export const DIMMED = 'var(--viz-dimmed)'

export const groupColour = (index: number) => GROUP_COLOURS[index] ?? OTHER_COLOUR

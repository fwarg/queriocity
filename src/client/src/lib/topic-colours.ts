/** Colours for groups — top-level tags or topics — biggest first; the rest share OTHER_COLOUR.
 *  Readable on the dark background and distinct from each other at dot size. Shared so a topic has
 *  the same colour in the bubbles, the note map and the graph. */
export const GROUP_COLOURS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#2dd4bf', '#fb923c']
export const OTHER_COLOUR = '#d1d5db'
/** Whatever is not the point of the current view: other topics, notes in no topic. */
export const DIMMED = '#374151'

export const groupColour = (index: number) => GROUP_COLOURS[index] ?? OTHER_COLOUR

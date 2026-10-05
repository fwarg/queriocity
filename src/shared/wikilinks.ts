/** The text to insert for a link to `title`. Brackets and pipes cannot appear inside a wikilink, so
 *  a title containing them is approximated — and will not resolve until the resource is renamed. */
export const wikilinkFor = (title: string) => `[[${title.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim()}]]`

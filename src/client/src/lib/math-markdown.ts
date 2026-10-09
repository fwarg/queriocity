/** Markdown math as remark-math reads it: `$…$` inline and `$$…$$` display, never currency. */
export function prepareMath(content: string): string {
  return escapeCurrencyDollars(latexDelimitersToDollars(content))
}

/** Rewrite LaTeX's `\(…\)` and `\[…\]`, which models often emit, to the dollar delimiters
 *  remark-math understands. Code is untouched. Assumes a bare `\[` in prose is math, not an
 *  escaped bracket. */
export function latexDelimitersToDollars(content: string): string {
  return content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)/).map((part, i) => i % 2 ? part : part
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => `\n$$\n${tex.trim()}\n$$\n`)
    .replace(/\\\((.+?)\\\)/g, (_, tex: string) => `$${tex.trim()}$`)).join('')
}

/** Escape currency dollars ("$5 and $10") so remark-math doesn't pair them into a formula, while
 *  leaving inline math that starts with a digit ("$0.98$") alone. Follows Pandoc's rule: a closing
 *  `$` has no space before it and no digit after it, so a `$` before a digit with no such closer
 *  later on the line is currency. Code spans, fenced blocks and `$$` display math are untouched. */
export function escapeCurrencyDollars(content: string): string {
  let fenced = false
  let display = false
  return content.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
    if (!fenced && line.trim() === '$$') { display = !display; return line }
    return fenced || display ? line : line.split(/(`+[^`]*`+)/).map((part, i) => i % 2 ? part : escapeLine(part)).join('')
  }).join('\n')
}

/** One line of prose (no code) with its currency dollars escaped. */
function escapeLine(line: string): string {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\') { out.push(line.slice(i, i + 2)); i += 2; continue }
    if (ch !== '$') { out.push(ch); i++; continue }
    if (line[i + 1] === '$') { const end = line.indexOf('$$', i + 2); const stop = end < 0 ? line.length : end + 2; out.push(line.slice(i, stop)); i = stop; continue }
    const close = closingDollar(line, i)
    if (close >= 0) { out.push(line.slice(i, close + 1)); i = close + 1; continue }
    out.push(/\d/.test(line[i + 1] ?? '') ? '\\$' : '$')
    i++
  }
  return out.join('')
}

/** Index of the `$` closing inline math opened at `open`, or -1. */
function closingDollar(line: string, open: number): number {
  if (/\s/.test(line[open + 1] ?? ' ')) return -1
  for (let j = open + 2; j < line.length; j++) {
    if (line[j] === '\\') { j++; continue }
    if (line[j] === '$' && !/\s/.test(line[j - 1]) && !/\d/.test(line[j + 1] ?? '')) return j
  }
  return -1
}

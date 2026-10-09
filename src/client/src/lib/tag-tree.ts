import { isUnder } from '@shared/tags.ts'

/** One tag in the Explore tree. `total` counts resources carrying it or anything under it, each once. */
export interface TagTreeNode {
  path: string
  name: string
  /** Resources tagged exactly this path. */
  own: number
  total: number
  children: TagTreeNode[]
}

/** Builds the tag hierarchy from each resource's tag paths. Parents that no resource carries
 *  directly still appear, so `ml/rag` alone yields `ml` with one child. */
export function buildTagTree(resources: Array<{ tags: string[] }>): TagTreeNode[] {
  const paths = new Set<string>()
  for (const r of resources) for (const tag of r.tags) {
    const parts = tag.split('/')
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'))
  }
  const node = (path: string): TagTreeNode => ({
    path,
    name: path.split('/').pop()!,
    own: resources.filter(r => r.tags.includes(path)).length,
    total: resources.filter(r => r.tags.some(tag => isUnder(tag, path))).length,
    children: [...paths].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')).sort().map(node),
  })
  return [...paths].filter(p => !p.includes('/')).sort().map(node)
}

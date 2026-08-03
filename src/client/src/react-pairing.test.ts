/** Guards against react and react-dom drifting apart.
 *
 *  A Dependabot PR bumped `react` to 19 without `react-dom`, which builds and typechecks
 *  cleanly and then dies at runtime with "can't access property ReactCurrentBatchConfig" —
 *  a React 18 internal that React 19 removed — leaving a blank page. Nothing else in CI
 *  catches a renderer/runtime mismatch, so assert it directly. */

import { describe, test, expect } from 'bun:test'

const major = (v: string) => v.replace(/^[^0-9]*/, '').split('.')[0]

async function installedVersion(pkg: string): Promise<string> {
  const { version } = await Bun.file(`node_modules/${pkg}/package.json`).json()
  return version
}

describe('react / react-dom pairing', () => {
  test('installed react and react-dom share a major version', async () => {
    const [react, reactDom] = await Promise.all([
      installedVersion('react'),
      installedVersion('react-dom'),
    ])
    expect(`react-dom ${major(reactDom)}`).toBe(`react-dom ${major(react)}`)
  })

  test('the declared ranges agree too, so a fresh install cannot split them', async () => {
    const pkg = await Bun.file('package.json').json()
    expect(major(pkg.dependencies['react-dom'])).toBe(major(pkg.dependencies.react))
  })

  test('the react type packages match the runtime major', async () => {
    const [react, types, typesDom] = await Promise.all([
      installedVersion('react'),
      installedVersion('@types/react'),
      installedVersion('@types/react-dom'),
    ])
    expect(major(types)).toBe(major(react))
    expect(major(typesDom)).toBe(major(react))
  })
})

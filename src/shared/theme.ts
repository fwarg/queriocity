/** Colour themes a user can pick. E-ink is a high-contrast light theme without animation. */
export const THEMES = ['dark', 'light', 'eink'] as const
export type Theme = typeof THEMES[number]
export const DEFAULT_THEME: Theme = 'dark'

/** The theme named by `value`, or undefined when it is not one. */
export const toTheme = (value: unknown): Theme | undefined =>
  THEMES.includes(value as Theme) ? value as Theme : undefined

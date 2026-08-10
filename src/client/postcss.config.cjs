// Tailwind v4 ships its own PostCSS plugin and handles vendor prefixing internally, so
// autoprefixer is gone. Content detection is automatic — it scans from the CSS entry point,
// which is why there is no longer a tailwind.config.cjs listing globs.
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

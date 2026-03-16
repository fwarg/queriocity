module.exports = {
  plugins: [
    require('tailwindcss')({
      content: [
        './index.html',
        './src/**/*.{ts,tsx}',
      ],
      theme: { extend: {} },
      plugins: [],
    }),
    require('autoprefixer'),
  ],
}

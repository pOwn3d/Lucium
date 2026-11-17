// Vite's `?raw` suffix: the file's text, put into the bundle at build time.
declare module '*?raw' {
  const source: string
  export default source
}

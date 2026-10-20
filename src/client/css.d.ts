/** Ambient declaration for the esbuild text loader (`--loader:.css=text`). */
declare module '*.css' {
  const css: string
  export default css
}

// Ambient stubs for optional runtime dependencies. The real types come from the
// packages themselves once installed via `npm install`.
declare module "nspell" {
  interface Nspell {
    correct(word: string): boolean
    suggest(word: string): string[]
  }
  function nspell(dict: { aff: Buffer | Uint8Array; dic: Buffer | Uint8Array }): Nspell
  export default nspell
}

declare module "dictionary-en" {
  const dictionary: unknown
  export default dictionary
}

declare module "dictionary-ru" {
  const dictionary: unknown
  export default dictionary
}

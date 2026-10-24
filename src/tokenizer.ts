/**
 * tokenizer.ts
 * ------------
 * Splits raw prompt text into candidate natural-language words together with
 * their absolute character offsets, while deliberately *skipping* everything
 * that should never be spell-checked in a coding-agent prompt:
 *
 *   - fenced code blocks ``` ... ``` and inline code `...`
 *   - @file references (opencode fuzzy file mentions)
 *   - /slash-commands and !shell lines
 *   - URLs, emails, file paths, hex, numbers, versions
 *   - identifiers: camelCase, snake_case, kebab-case, ALLCAPS acronyms
 *
 * Offsets are returned so the caller can (optionally) place inline
 * highlights/extmarks over the exact span of a misspelling.
 */

export interface Token {
  /** the raw word as it appears in the text */
  word: string
  /** inclusive start offset in the original string */
  start: number
  /** exclusive end offset in the original string */
  end: number
}

/** A word must look like natural language to be worth checking. */
const WORD_RE = /[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё']*/gu

// Regions of the text that must be blanked out (replaced with spaces so that
// offsets are preserved) before we tokenize.
const MASK_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g, // fenced code block
  /`[^`\n]*`/g, // inline code
  /https?:\/\/\S+/gi, // URLs
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, // emails
  /(?:^|\s)@[^\s]+/g, // @file mentions
  /(?:^|[\s("'`[])[\w.~-]*\/[^\s\])}"'`]+/g, // file paths containing a slash — bare ("src/index.ts") or prefixed ("./src/index.ts", "~/.bashrc", "/usr/bin")
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|json|jsonc|ya?ml|toml|md|mdx|txt|xml|html?|css|scss|less|sql|sh|bash|zsh|env|ini|cfg|conf|lock|log|csv|svg)\b/gi, // bare filenames with a code/config extension and no path separator (e.g. "config.yaml", "README.md")
  /\b0x[0-9a-fA-F]+\b/g, // hex literals
  /\bv?\d+(?:\.\d+)+(?:[-+][\w.]+)?\b/g, // version numbers / semver
  /\b\d[\w.]*\b/g, // anything starting with a digit
]

/** Replace a matched region with spaces of equal length (keeps offsets stable). */
function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => " ".repeat(m.length))
}

/** True if a word is an identifier we should not flag (camelCase, snake_case, etc.). */
function isIdentifierLike(word: string): boolean {
  // snake_case fragments never reach here as a single WORD_RE match (the
  // regex can't capture underscores) — they're caught by the before/after
  // neighbour check below instead.
  if (/[a-z][A-Z]/.test(word)) return true // camelCase / PascalCase transition
  if (/^[A-Z]{2,}$/.test(word)) return true // ALLCAPS acronym (API, HTTP, CAISO...)
  if (/^[A-Z]+[a-z]+[A-Z]/.test(word)) return true // PascalCase
  return false
}

export interface TokenizeOptions {
  /** minimum length of a word to be checked (default 3) */
  minLength?: number
  /** if a line starts with one of these, skip the whole line */
  skipLinePrefixes?: string[]
  /** skip the last word if it is not followed by a delimiter (still being typed) */
  skipIncomplete?: boolean
}

/**
 * Produce the list of checkable tokens for a piece of prompt text.
 */
export function tokenize(text: string, opts: TokenizeOptions = {}): Token[] {
  const minLength = opts.minLength ?? 3
  const skipPrefixes = opts.skipLinePrefixes ?? ["/", "!"]
  const skipIncomplete = opts.skipIncomplete ?? false

  // 1. Mask out non-prose regions, preserving character offsets.
  let masked = text
  for (const re of MASK_PATTERNS) masked = blank(masked, re)

  // 2. Blank out whole lines that begin with a command/shell prefix.
  masked = masked
    .split("\n")
    .map((line) => {
      const firstChar = line.trimStart()[0]
      if (firstChar && skipPrefixes.includes(firstChar)) {
        return " ".repeat(line.length)
      }
      return line
    })
    .join("\n")

  // 3. Tokenize the surviving prose.
  const tokens: Token[] = []
  let m: RegExpExecArray | null
  WORD_RE.lastIndex = 0
  while ((m = WORD_RE.exec(masked)) !== null) {
    const raw = m[0]
    // Strip leading/trailing apostrophes that WORD_RE may capture.
    const word = raw.replace(/^'+|'+$/g, "")
    if (word.length < minLength) continue
    if (isIdentifierLike(word)) continue
    const start = m.index + raw.indexOf(word)
    const end = start + word.length
    // Skip a fragment that is part of a snake_case/kebab-case identifier, i.e.
    // one whose immediate neighbour in the source is '_' or '-'.
    const before = masked[start - 1]
    const after = masked[end]
    if (before === "_" || before === "-" || after === "_" || after === "-") {
      continue
    }
    // If skipIncomplete is enabled, skip the last word if it's not followed by
    // a delimiter (still being typed).
    if (skipIncomplete && end >= masked.length) {
      continue
    }
    tokens.push({ word, start, end })
  }
  return tokens
}

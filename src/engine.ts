/**
 * engine.ts
 * ---------
 * A thin, resilient wrapper around a Hunspell-backed spell checker (`nspell`
 * + `dictionary-en`). It adds:
 *   - a per-word LRU-ish result cache (checking is called on every keystroke)
 *   - a project vocabulary supplied through the plugin's `extraWords` option
 *   - dictionary-generated fallback suggestions: when nspell's n-gram
 *     suggester comes up empty ("miscellenous" → []), candidates are
 *     generated straight from the raw dictionary via bounded
 *     Damerau-Levenshtein and merged with nspell's own
 *   - lazy async initialisation that never blocks the TUI render loop
 *
 * If the optional dependencies are unavailable, the engine degrades to a
 * no-op (returns "everything is spelled correctly") so the plugin can never
 * break the prompt.
 */

export interface SpellResult {
  correct: boolean
  suggestions: string[]
}

export type Nspell = {
  correct(word: string): boolean
  suggest(word: string): string[]
}

export interface HunspellData {
  aff: Uint8Array | Buffer
  dic: Uint8Array | Buffer
}

export interface EngineOptions {
  /** extra words to always accept (e.g. project jargon: CAISO, BESS, ...) */
  extraWords?: string[]
  /** max suggestions to compute per word */
  maxSuggestions?: number
  /**
   * Pre-loaded Hunspell data. When provided (the *bundled* build supplies this
   * from embedded, gzip-compressed data) the engine skips the dynamic import of
   * `dictionary-en`, making the plugin fully self-contained.
   */
  dictionary?: HunspellData | (() => Promise<HunspellData>)
  /**
   * Multiple dictionaries (e.g. Russian + English). When provided, overrides
   * `dictionary`. A word is considered correct if ANY dictionary accepts it.
   */
  dictionaries?: (HunspellData | (() => Promise<HunspellData>))[]
  /**
   * Factory that builds an Nspell instance from Hunspell data. The bundled
   * build passes the statically-imported `nspell` here so esbuild inlines it.
   */
  nspellFactory?: (dict: HunspellData) => Nspell
  /**
   * Disable suggestion generation for faster checking. Only marks words as
   * incorrect without computing corrections.
   */
  disableSuggestions?: boolean
}

export class SpellEngine {
  private nspells: Nspell[] = []
  private ready: Promise<void>
  private cache = new Map<string, SpellResult>()
  private personal = new Set<string>()
  private readonly maxSuggestions: number
  private readonly dictionariesOpt?: (HunspellData | (() => Promise<HunspellData>))[]
  private readonly dictionaryOpt?: EngineOptions["dictionary"]
  private readonly nspellFactory?: EngineOptions["nspellFactory"]
  private readonly disableSuggestions: boolean
  public available = false
  /**
   * Lowercased dictionary words, bucketed by length, parsed from the same
   * `.dic` bytes nspell consumes. Lets us *generate* correction candidates
   * from the raw dictionary when nspell's own n-gram suggester comes up
   * short or wrong. Null when the engine is in no-op mode or the parse
   * failed (suggestions then simply come from nspell alone).
   */
  private dictByLens: (Map<number, string[]> | null)[] = []

  constructor(opts: EngineOptions = {}) {
    this.maxSuggestions = opts.maxSuggestions ?? 5
    this.dictionaryOpt = opts.dictionary
    this.dictionariesOpt = opts.dictionaries
    this.nspellFactory = opts.nspellFactory
    this.disableSuggestions = opts.disableSuggestions ?? false
    for (const w of opts.extraWords ?? []) this.personal.add(w.toLowerCase())
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    // Resolve the Hunspell data and an Nspell factory. The bundled build injects
    // both (embedded dictionary + statically-imported nspell); dev/source mode
    // falls back to dynamic imports so a missing dep can never crash the TUI.
    try {
      const factory =
        this.nspellFactory ??
        (((await import("nspell")) as any).default as EngineOptions["nspellFactory"])

      // Build list of dictionaries to load
      let dictSources: (HunspellData | (() => Promise<HunspellData>))[]
      if (this.dictionariesOpt && this.dictionariesOpt.length > 0) {
        dictSources = this.dictionariesOpt
      } else if (this.dictionaryOpt) {
        dictSources = [this.dictionaryOpt]
      } else {
        const mod: any = await import("dictionary-ru")
        const maybe = mod.default ?? mod
        dictSources = [await new Promise<HunspellData>((resolve, reject) => {
          if (typeof maybe === "function") {
            maybe((err: Error | null, d: any) => (err ? reject(err) : resolve(d)))
          } else {
            Promise.resolve(maybe).then(resolve, reject)
          }
        })]
      }

      // Load all dictionaries and create nspell instances
      this.nspells = []
      this.dictByLens = []
      for (const dictOpt of dictSources) {
        let dict: HunspellData
        if (typeof dictOpt === "function") {
          dict = await dictOpt()
        } else {
          dict = dictOpt
        }
        this.nspells.push(factory!(dict) as Nspell)
        try {
          this.dictByLens.push(buildDictIndex(dict))
        } catch {
          this.dictByLens.push(null)
        }
      }

      this.available = this.nspells.length > 0
    } catch (err) {
      // Optional deps not installed → graceful no-op mode.
      this.available = false
    }
  }

  /** Wait until initialisation has settled. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  /** Accept a word permanently for this session (project vocabulary). */
  addWord(word: string): void {
    const key = word.toLowerCase()
    this.personal.add(key)
    this.cache.delete(key)
  }

  /**
   * Synchronous check used inside the render/keystroke path. Returns a cached
   * or freshly-computed result. If the engine isn't ready yet it optimistically
   * reports "correct" (nothing is flagged until the dictionary is loaded).
   */
  check(word: string): SpellResult {
    const key = word.toLowerCase()
    if (this.personal.has(key)) return { correct: true, suggestions: [] }
    if (this.nspells.length === 0) return { correct: true, suggestions: [] }

    const cached = this.cache.get(key)
    if (cached) return cached

    // Check if ANY dictionary considers this word correct
    let correct = false
    for (const ns of this.nspells) {
      if (ns.correct(word) || ns.correct(key)) {
        correct = true
        break
      }
    }

    let suggestions: string[] = []
    if (!correct && !this.disableSuggestions) {
      // Only pay for nspell.suggest() + the dictionary scan — the expensive
      // parts of a Hunspell check — when the word actually needs a
      // correction; most words in real prose are already correct. nspell's
      // suggester is n-gram based and often returns nothing for typos more
      // than ~1 edit from the dictionary ("miscellenous" → []), so we union
      // its raw output with candidates generated straight from the
      // dictionary, then rank the *full* merged list before truncating to
      // maxSuggestions — a strong match buried deep in nspell's own output
      // must not be discarded before it's compared.
      const nspellCandidates: string[] = []
      for (const ns of this.nspells) {
        nspellCandidates.push(...ns.suggest(word))
      }
      suggestions = this._mergeCandidates(
        word,
        nspellCandidates,
        this._dictionaryCandidates(word),
      ).slice(0, this.maxSuggestions)
    }

    const result: SpellResult = correct
      ? { correct: true, suggestions: [] }
      : {
          correct: false,
          suggestions,
        }

    // Keep the cache from growing without bound.
    if (this.cache.size > 5000) this.cache.clear()
    this.cache.set(key, result)
    return result
  }

  /**
   * Union nspell's raw suggestions with our dictionary-generated ones,
   * dedupe case-insensitively (nspell's casing wins on collision — nspell
   * knows the real inflection/case of its candidates), and rank the merged
   * set with the shared scorer. Totals are tiny (nspell's ~15 + ≤10
   * generated), so full ranking beats truncating the sources first.
   */
  private _mergeCandidates(
    target: string,
    nspellWords: string[],
    dictWords: string[],
  ): string[] {
    const seen = new Set<string>()
    const scored: Array<{ word: string; score: number }> = []
    const add = (w: string) => {
      const key = w.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      scored.push({ word: w, score: this._scoreSuggestion(target, w) })
    }
    for (const w of nspellWords) add(w)
    for (const w of dictWords) add(w)
    scored.sort((a, b) => a.score - b.score)
    return scored.map((s) => s.word)
  }

  /**
   * Generate correction candidates directly from the raw dictionary word
   * index (parsed from the same `.dic` nspell uses) via a bounded
   * Damerau-Levenshtein search over the length-neighbourhood buckets. This
   * fills the gap where nspell's n-gram suggester returns nothing —
   * "miscellenous" (nspell: []) → "miscellaneous" — or buries the true
   * fix. Only runs for misspelled words (never the common correct-word
   * path) and the result is cached by `check()`, so it's paid at most once
   * per distinct typo.
   */
  private _dictionaryCandidates(target: string): string[] {
    const t = target.toLowerCase()
    // The bucketed search is O(neighbourhood); a few ms worst case. Very
    // long tokens are usually not prose — skip to stay out of the
    // pathological case.
    if (t.length < 3 || t.length > 18) return []
    const maxDist = 3
    const matches: Array<{ word: string; score: number }> = []
    // Search across all dictionaries
    for (const index of this.dictByLens) {
      if (!index) continue
      for (
        let len = Math.max(2, t.length - maxDist);
        len <= t.length + maxDist;
        len++
      ) {
        const bucket = index.get(len)
        if (!bucket) continue
        for (const w of bucket) {
          if (this._distBounded(t, w, maxDist) <= maxDist) {
            matches.push({ word: w, score: this._scoreSuggestion(t, w) })
          }
        }
      }
    }
    matches.sort((a, b) => a.score - b.score)
    // Keep the strongest handful; `check()` unions these with nspell's own
    // suggestions before capping at maxSuggestions.
    return matches.slice(0, 10).map((m) => m.word)
  }

  /**
   * Score a suggestion: lower is better (more likely to be the correct fix).
   * Uses Damerau-Levenshtein edit distance — insertions, deletions,
   * substitutions, and *adjacent transpositions* each cost one edit.
   *
   * A pure longest-common-subsequence measure is blind to transpositions:
   * "teh" is a perfect, order-preserving subsequence of "tech" (LCS ratio
   * 1.0 — just insert a "c"), but only a partial match against "the" (the
   * swap breaks the subsequence), even though "the" is exactly as close a
   * fix — one transposition — as "tech" is one insertion. Edit distance
   * alone fixes that, but real Hunspell suggestion lists also contain a
   * pile of single-*substitution* candidates the same distance away (for
   * "teh": ten, tea, ted, tel, tex, ...) — so distance alone leaves "the"
   * tied with all of them. Adjacent transpositions are overwhelmingly the
   * most common typo type in practice, so they get a small tiebreaking
   * bonus among equal-distance candidates; the length-difference term
   * breaks any remaining ties by preferring the candidate closest in
   * length to the typo.
   */
  private _scoreSuggestion(target: string, suggestion: string): number {
    const s = suggestion.toLowerCase()
    const dist = this._editDistance(target, s)
    const lenDiff = Math.abs(s.length - target.length)
    // Among candidates an equal edit distance away, prefer the one whose
    // *leftmost* run matches the typo: typos overwhelmingly corrupt the
    // tail of a word, so "grammer" should fix to "grammar", not "crammer"
    // (both are one substitution away).
    const leftPenalty = 10 - Math.min(10, this._leftCommonLength(target, s))
    const transposition = this._isAdjacentTransposition(target, s) ? 10 : 0
    return dist * 100 + lenDiff + leftPenalty - transposition
  }

  /** Length of the shared prefix of `a` and `b`. */
  private _leftCommonLength(a: string, b: string): number {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }

  /**
   * True if `b` is exactly `a` with one pair of adjacent letters swapped
   * (and otherwise identical) — the "teh"/"the" case specifically, as
   * opposed to a substitution, insertion, or deletion that happens to cost
   * the same single edit.
   */
  private _isAdjacentTransposition(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    if (i >= a.length - 1) return false
    return (
      a[i] === b[i + 1] &&
      a[i + 1] === b[i] &&
      a.slice(i + 2) === b.slice(i + 2)
    )
  }

  /**
   * Damerau-Levenshtein edit distance (restricted / "optimal string
   * alignment" variant): the minimum number of insertions, deletions,
   * substitutions, and adjacent-pair transpositions needed to turn `a`
   * into `b`.
   */
  private _editDistance(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

    for (let i = 0; i <= m; i++) d[i][0] = i
    for (let j = 0; j <= n; j++) d[0][j] = j

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        d[i][j] = Math.min(
          d[i - 1][j] + 1, // deletion
          d[i][j - 1] + 1, // insertion
          d[i - 1][j - 1] + cost, // substitution
        )
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1) // transposition
        }
      }
    }
    return d[m][n]
  }

  /**
   * Bounded Damerau-Levenshtein (restricted "optimal string alignment"
   * variant). Returns the exact distance when it is ≤ `max`, otherwise
   * `max + 1` — relying on the fact that any edit path with ≤ max edits
   * keeps the DP cell on the |i−j| ≤ max diagonal band, so cells outside
   * the band can never lie on a short path and the full matrix isn't
   * needed. This keeps scanning tens of thousands of dictionary words
   * cheap enough for the per-keystroke path (each row is only ~2·max+1
   * cells wide, and an early bail-out abandons a word as soon as its whole
   * band exceeds max).
   */
  private _distBounded(a: string, b: string, max: number): number {
    const m = a.length
    const n = b.length
    const INF = max + 1
    if (Math.abs(m - n) > max) return INF
    if (m === 0) return n <= max ? n : INF
    if (n === 0) return m <= max ? m : INF
    let r0 = new Array<number>(n + 1).fill(INF) // row i-2
    let r1 = new Array<number>(n + 1).fill(INF) // row i-1
    let r2 = new Array<number>(n + 1).fill(INF) // row i
    for (let j = 0; j <= max && j <= n; j++) r1[j] = j
    for (let i = 1; i <= m; i++) {
      const lo = Math.max(1, i - max)
      const hi = Math.min(n, i + max)
      r2[0] = i > max ? INF : i
      for (let j = lo; j <= hi; j++) {
        let v = Math.min(
          r1[j] + 1, // deletion
          r2[j - 1] + 1, // insertion
          r1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
        )
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, r0[j - 2] + 1) // transposition
        }
        r2[j] = v
      }
      // If the whole band of this row exceeds max, no ≤max-edit path can
      // pass through it, so the distance is > max — prune early.
      let rowMin = INF
      for (let j = lo; j <= hi; j++) if (r2[j] < rowMin) rowMin = r2[j]
      if (rowMin > max) return INF
      const t = r0
      r0 = r1
      r1 = r2
      r2 = t
      // Recycled buffer: out-of-band cells must never leak stale values
      // into a later band via the deletion branch.
      r2.fill(INF)
    }
    return r1[n]
  }
}

/**
 * Parse the Hunspell `.dic` body (the same bytes nspell itself consumes)
 * into a lowercase word index bucketed by word length. The format is plain
 * text: a line count, then one "word/flags" entry per line. Only plain
 * alpha(+apostrophe) tokens in a sane length range are kept — those are
 * the words the tokenizer can flag as prose typos.
 */
function buildDictIndex(dict: HunspellData): Map<number, string[]> | null {
  const buf = Buffer.isBuffer(dict.dic) ? dict.dic : Buffer.from(dict.dic)
  const index = new Map<number, string[]>()
  const seen = new Set<string>()
  const lines = buf.toString("utf8").split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    let line = lines[i].trim()
    if (!line) continue
    const slash = line.indexOf("/")
    if (slash !== -1) line = line.slice(0, slash)
    const w = line.toLowerCase()
    if (w.length < 2 || w.length > 24) continue
    if (!/^[\p{L}][\p{L}']*$/u.test(w)) continue
    if (seen.has(w)) continue
    seen.add(w)
    let bucket = index.get(w.length)
    if (!bucket) {
      bucket = []
      index.set(w.length, bucket)
    }
    bucket.push(w)
  }
  return index.size > 0 ? index : null
}

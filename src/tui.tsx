/**
 * OpenCode 2 CLI (TUI) entrypoint.
 *
 * OpenCode 2's documented TUI plugin API does not expose the prompt buffer
 * directly, so this plugin polls the focused OpenTUI editor
 * (`context.renderer.currentFocusedEditor.plainText`) — the same object the
 * built-in prompt composer uses. Checks are debounced, and only completed
 * words (followed by a delimiter) are flagged, so a half-typed word is never
 * reported.
 *
 * A `/spellcheck <text>` slash command is also registered as an explicit
 * fallback and for remote setups where polling is unavailable.
 */

import { appendFileSync } from "node:fs"
import { createEffect, createRoot, createSignal, Show } from "solid-js"

import { Plugin } from "@opencode/plugin/tui"

import { SpellingBanner, type SpellingError } from "./banner"
import { SpellEngine } from "./engine"
import { tokenize, type Token } from "./tokenizer"
import { embeddedDictionaries } from "./generated/dict-data"

const PLUGIN_ID = "spellcheck"
const DEBOUNCE_MS = 250
const POLL_MS = 50

interface Options {
  debounceMs?: number
  minLength?: number
  extraWords?: string[]
  showStatusLine?: boolean
  /** Also show the compact toast in addition to the red banner. */
  showToast?: boolean
  fastMode?: boolean
  toastDuration?: number
  debugLog?: boolean
}

function buildToastMessage(engine: SpellEngine, bad: Token[]): string {
  const shown = bad
    .slice(0, 5)
    .map((token) => {
      const suggestion = engine.check(token.word).suggestions[0]
      return suggestion ? `${token.word}→${suggestion}` : token.word
    })
    .join("  ")
  const more = bad.length > 5 ? ` (+${bad.length - 5})` : ""
  return `✎ ${bad.length} ошиб.: ${shown}${more}`
}

function createDebug(debugLog: boolean) {
  if (!debugLog) return (_message: string) => {}
  return (message: string) => {
    try {
      appendFileSync(
        "/tmp/opencode-spellcheck-v2.log",
        `[${new Date().toISOString()}] ${message}\n`,
      )
    } catch {
      /* never break the TUI over logging */
    }
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const options = (context.options ?? {}) as Options
    const debug = createDebug(options.debugLog === true)

    const configuredDebounce = options.debounceMs ?? DEBOUNCE_MS
    const debounceMs = Number.isFinite(configuredDebounce)
      ? Math.max(0, configuredDebounce)
      : DEBOUNCE_MS

    const configuredMinLength = options.minLength ?? 3
    const minLength = Number.isFinite(configuredMinLength)
      ? Math.max(1, Math.floor(configuredMinLength))
      : 3

    const configuredToastDuration = options.toastDuration ?? 6000
    const toastDuration = Number.isFinite(configuredToastDuration)
      ? Math.max(0, configuredToastDuration)
      : 6000

    const showStatusLine = options.showStatusLine ?? true

    // Durable custom vocabulary. The host owns this store, so it survives
    // restarts and stays in sync across TUI instances.
    const [customWords, updateCustomWords] = context.storage.store(
      "custom-words",
      { initial: { words: [] as string[] } },
    )

    const optionWords = Array.isArray(options.extraWords)
      ? options.extraWords.filter(
          (word): word is string => typeof word === "string",
        )
      : []

    const engine = new SpellEngine({
      extraWords: [...optionWords, ...customWords.words],
      dictionaries: embeddedDictionaries.map((dictionary) => ({
        aff: dictionary.aff,
        dic: dictionary.dic,
      })),
      disableSuggestions: options.fastMode === true,
    })

    let lastInput = ""
    let lastSignature = ""
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let disposeBannerSlots: Array<() => void> = []

    const readPrompt = (): string => {
      try {
        return context.renderer.currentFocusedEditor?.plainText ?? ""
      } catch {
        return ""
      }
    }

    const addWord = (word: string) => {
      const key = word.toLowerCase()
      if (!customWords.words.includes(key)) {
        updateCustomWords((draft) => {
          draft.words.push(key)
        })
      }
      engine.addWord(key)
      lastSignature = ""
      check(readPrompt())
    }

    const openAddDialog = async (errors: SpellingError[]) => {
      if (errors.length === 0) return
      const choice = await context.ui.dialog.select({
        title: "Добавить в словарь",
        options: errors.map((error) => ({
          title: error.word,
          value: error.word,
          description: error.suggestion
            ? `→ ${error.suggestion}`
            : undefined,
        })),
      })
      if (!choice) return
      addWord(choice)
    }

    // OpenCode 2 runs slot renders untracked, so signals do not re-render a
    // mounted slot. Re-register the banner instead whenever errors change.
    const renderBanner = (errors: SpellingError[]) => {
      for (const dispose of disposeBannerSlots) {
        try {
          dispose()
        } catch {
          /* slot already released */
        }
      }
      disposeBannerSlots = []
      if (!showStatusLine || errors.length === 0) return

      disposeBannerSlots.push(
        context.ui.slot({
          append: "session.composer.top",
          render: () => (
            <SpellingBanner
              errors={errors}
              onAdd={() => openAddDialog(errors)}
            />
          ),
        }),
      )
      disposeBannerSlots.push(
        context.ui.slot({
          append: "prompt.footer.status",
          render: (input) => (
            <Show when={!input.sessionID}>
              <SpellingBanner
                errors={errors}
                onAdd={() => openAddDialog(errors)}
              />
            </Show>
          ),
        }),
      )
    }

    const [spellingErrors, setSpellingErrors] = createSignal<SpellingError[]>([])
    const disposeBannerRoot = createRoot((dispose) => {
      // Re-apply durable custom words if the host loads them asynchronously.
      createEffect(() => {
        for (const word of customWords.words) engine.addWord(word)
      })
      createEffect(() => {
        debug(`effect errors=${spellingErrors().length}`)
        renderBanner(spellingErrors())
      })
      return dispose
    })

    const notify = (bad: Token[]) => {
      if (!showStatusLine || bad.length === 0) {
        setSpellingErrors([])
        lastSignature = ""
        return
      }

      const errors: SpellingError[] = bad.map((token) => ({
        word: token.word,
        suggestion: engine.check(token.word).suggestions[0],
      }))
      debug(`set errors=${errors.length}`)

      const signature = `${bad.length}:${bad
        .slice(0, 8)
        .map((token) => token.word)
        .join("|")}`
      if (signature === lastSignature) return
      lastSignature = signature
      setSpellingErrors(errors)

      if (options.showToast === true) {
        context.ui.toast.show({
          title: "Орфография",
          message: buildToastMessage(engine, bad),
          variant: "error",
          duration: toastDuration,
        })
      }
    }

    const check = (input: string) => {
      if (!engine.available) return
      debug(`check input=${JSON.stringify(input.slice(0, 80))}`)
      const tokens = tokenize(input, { minLength, skipIncomplete: true })
      const bad = tokens.filter((token) => !engine.check(token.word).correct)
      debug(`bad=${JSON.stringify(bad.map((token) => token.word))}`)
      notify(bad)
    }

    const poll = () => {
      if (!engine.available) return
      const input = readPrompt()
      if (input === lastInput) return
      lastInput = input

      if (!input) {
        setSpellingErrors([])
        lastSignature = ""
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = null
        return
      }

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        // A newer keystroke may have arrived while this timer was pending.
        if (readPrompt() === input) check(input)
      }, debounceMs)
    }

    const pollTimer = setInterval(poll, POLL_MS)
    poll()

    // Explicit fallback: /spellcheck <text>
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "spellcheck.check",
          title: "Проверить орфографию",
          description: "Проверить текст на орфографические ошибки",
          group: "Spellcheck",
          palette: true,
          slash: { name: "spellcheck", aliases: ["spell"], arguments: true },
          async run(input?: string) {
            await engine.whenReady()
            const text =
              input?.trim() ||
              (await context.ui.dialog.prompt({
                title: "Проверка орфографии",
                placeholder: "Введите текст",
              }))
            if (!text) return
            const tokens = tokenize(text, { minLength, skipIncomplete: false })
            const bad = tokens.filter(
              (token) => !engine.check(token.word).correct,
            )
            if (bad.length === 0) {
              context.ui.toast.show({
                title: "Орфография",
                message: "Ошибок не найдено",
                variant: "success",
                duration: toastDuration,
              })
              return
            }
            context.ui.toast.show({
              title: "Орфография",
              message: buildToastMessage(engine, bad),
              variant: "error",
              duration: toastDuration,
            })
          },
        },
      ],
      bindings: ["spellcheck.check"],
    }))

    return () => {
      clearInterval(pollTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const dispose of disposeBannerSlots) {
        try {
          dispose()
        } catch {
          /* slot already released */
        }
      }
      disposeBannerSlots = []
      disposeBannerRoot()
    }
  },
})

import { Show } from "solid-js"

export interface SpellingError {
  word: string
  suggestion?: string
}

function describe(errors: SpellingError[]): string {
  const shown = errors
    .slice(0, 5)
    .map((error) =>
      error.suggestion ? `${error.word}→${error.suggestion}` : error.word,
    )
    .join("  ")
  const more = errors.length > 5 ? ` (+${errors.length - 5})` : ""
  return `✎ Орфография: ${errors.length} — ${shown}${more}`
}

/**
 * Persistent red banner shown above the prompt (sessions) or in the prompt
 * footer (home). A plain toast only draws colored side borders, so this uses a
 * slot with a full red background to make mistakes much more visible.
 *
 * Slot renders run untracked in OpenCode 2, so this component is intentionally
 * static: the plugin re-registers the slot whenever the error list changes.
 */
export function SpellingBanner(props: {
  errors: SpellingError[]
  onAdd?: () => void
}) {
  return (
    <Show when={props.errors.length > 0}>
      <box
        backgroundColor="#b91c1c"
        border={["top", "bottom"]}
        borderColor="#ef4444"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
      >
        <text fg="#ffffff" attributes={1} flexShrink={1}>
          {describe(props.errors)}
        </text>
        <Show when={props.onAdd}>
          <text
            fg="#fecaca"
            attributes={1}
            flexShrink={0}
            onMouseUp={() => props.onAdd?.()}
          >
            [+ в словарь]
          </text>
        </Show>
      </box>
    </Show>
  )
}

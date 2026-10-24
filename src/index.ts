/**
 * OpenCode 2 server entrypoint.
 *
 * The actual spell checking runs in the terminal (see `tui.ts`), because only
 * the CLI can observe the live prompt buffer. This entrypoint exists so the
 * package can be registered through `plugins` in `opencode.json(c)` and so the
 * CLI loads the matching `./tui` export automatically.
 */

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "spellcheck",
  setup() {},
})

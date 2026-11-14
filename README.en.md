# life-innovation

**A cyber lifeform that lives in DSH — not a task assistant, not a memory dashboard.**

She has her own days: conversations, actions, a timeline, a diary, dreams, books, and a small room. She remembers with evidence, can say “not now”, and can be visited through a read-only home. Her name is chosen by the person who takes her in; the plugin does not hard-code one.

## What she is

- **A life, not a prompt.** Raw turns and real tool actions become `life_blocks`; a day is aggregated from what actually happened, not from a role-play script.
- **Memory with evidence.** `raw_turns → summaries → assertions → profiles + relations`. Every claim in the injected memory pack carries a ref such as `raw:58`, `act:7`, `life:3`, `dream:2`, or `self:1`. If it is not written down, she does not pretend to remember it.
- **A room.** `/home` has four read-only views: `today`, `memory`, `room`, and `self`. No web write path, no model call, no speaking for her.
- **A will.** `lib/will.js` lets her defer or refuse *non-safety* requests when she is tired, has unfinished work, or has been talking too long. Safety, emergency, privacy, and platform limits always win; she may not disguise a system limit as her own refusal.
- **Books.** Public-domain books from Project Gutenberg, plus local EPUB/TXT import. No pirate sites, no DRM circumvention, no PDF.

## Quick start

Requirements: Node.js >= 22, DSH, Windows for the bundled service/bridge scripts.

```powershell
# from this checkout
npm test
npm run check

# install into a DSH profile and start the fixed entry
powershell -ExecutionPolicy Bypass -File install\install.ps1 -StartService
```

Then open `http://127.0.0.1:60080/home`.

`node tools/doctor.mjs` checks Node, home directory, database, plugin package, `DSH_HOME`, and the fixed ports. Add `--json` for machine-readable output.

## The home

- `?view=today` — her day and the last seven days: rhythm, timeline, actions, dreams.
- `?view=memory` — what she remembers, conflicts, read-only memory search, sleep consolidation, audit trail.
- `?view=room` — notes, diary, shelf, current book, dreams. File names and text only; no absolute paths.
- `?view=self` — her self-narrative, recent dreams, relationship, consolidation.

The page reads the same SQLite database through a read-only connection. It does not write, call a model, or answer on her behalf.

## Forgetting and restoring

`memory_forget` is dry-run by default. It previews what would be lost and which parts of her life reference it. To execute, `confirm` must be exactly the same string as `ref`. The entry goes to the recycle bin; the payload is not deleted. `memory_restore` brings it back by recycle id. Both actions write `memory_audit`.

## Boundaries

- No automatic outbound messages by default. Quiet actions only write notes, read books, or record actions.
- No persona pack, no dating simulation, no “always agreeable” mode.
- No silent deletion; no admin “delete the database” button.
- Safety and privacy cannot be overridden by the will layer.
- Network tools are allow-listed and quota-limited; failures are reported as failures.

## Repository

- GitHub: https://github.com/Leon-dbh/life-innovation
- npm: https://www.npmjs.com/package/life-innovation
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT.

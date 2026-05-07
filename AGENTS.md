# AGENTS.md

## Project Structure

- `2_ToolSystem/` — Main project with full tool system (this is what to work on)
- `1_AgentLoop/` — Simpler agent loop (legacy/reference, not the main focus)

## Commands

```bash
cd 2_ToolSystem
pnpm dev      # Start with file watching (tsx watch)
pnpm start    # Run once
```

Requires `AI_KEY` in `2_ToolSystem/.env` for the AI SDK.

## Key Conventions

- **No build step** — Uses `tsx` to run TypeScript directly
- **Tool execution** — Tools are defined in `src/tools.ts` and `src/tools/*.ts`
- **Web app creation** — The agent has specific instructions (see `src/index.ts:57-72`):
  - Don't modify `app/index.html` (pre-configured with React via import maps)
  - Create `app/styles.css`, `app/App.tsx`, and components
  - Call `start_preview` after writing files
- **AI baseURL** — Uses custom endpoint `https://147ai.online/v1` (not OpenAI default)

## Testing

This project has no test framework. Test manually by running `pnpm dev` and interacting with the CLI.
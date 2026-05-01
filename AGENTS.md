# Repository Guidelines

## Project Structure & Module Organization
SayType (formerly WhispLine) is an Electron app. Core logic lives in `src/`, with the main process in `src/main.js` and renderer UI in `src/views/` (HTML/CSS/JS). Platform-specific helpers live alongside (e.g., `src/macos-text-inserter-koffi.js`). Build assets and entitlements are in `assets/` and `build/`, while packaged artifacts output to `dist/`.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run dev` launches Electron in development mode (`--dev`).
- `npm start` launches the app in production mode.
- `npm run build` packages for all platforms; use `npm run build:mac`, `npm run build:win`, or `npm run build:linux` for targeted builds.

## Coding Style & Naming Conventions
There is no enforced lint/format config in the repo. Match existing patterns in the file you touch: 2-space indentation, semicolons, and CommonJS `require(...)` in the main process. Prefer descriptive, action-oriented names (e.g., `transcriptionServiceCache`, `parseShortcut`). Keep UI strings in `src/views/i18n.js` when adding new copy.

## Testing Guidelines
No automated test framework is configured yet. For changes, do a manual pass: start the app (`npm run dev`), verify tray/menu actions, recording flow, and text insertion on your OS. Note any platform-specific behavior in the PR.

## Commit & Pull Request Guidelines
Recent history uses short, imperative messages, often with conventional prefixes (e.g., `feat: ...`, `refactor: ...`, `feat(ui): ...`). Follow that pattern when possible. PRs should include a concise summary, testing notes, and screenshots or short clips for UI changes. Call out permission-related updates (macOS accessibility/microphone) explicitly.

## Security & Configuration Tips
API keys are configured in-app and stored via `electron-store`; never commit secrets. If you adjust permissions or entitlements, update `build/entitlements.mac.plist` and document any new OS prompts or setup steps in `README.md`.

# Tests

`npm run ipc-test` (unix-socket election/forwarding/shutdown; prints SKIP where unix sockets are unavailable), `npm run core-test` and `npm run darwin-test` need no desktop. Most other tests drive the real desktop of the machine they run on (Windows only). They use their own `ISPYX_*` (or legacy `WIN_INPUT_*`) settings, so they get their own named pipe and, where a stop key is pressed, their own chord (`alt+f24`); they never interfere with a server you are using.

```
npm test               # unit checks (PNG, key parsing, password-field detection)
npm run smoke          # drives the real server over stdio against a fresh Notepad tab
npm run chrome-test    # Chrome end-to-end: Google search through the server (see below)
npm run stop-test      # banner shows, is click-through; the stop key cancels a running tool, a second press within 5 s shuts the server down
npm run motion-test    # pointer glides along a curve in 300-1000 ms, lands exactly
npm run typing-test    # typing pace and accuracy
npm run instances-test # several servers share one worker
npm run shutdown-test  # shutting down all instances
npm run auth-test      # the real password window (temp file only)
npm run instagram-test # new Chrome window, scroll checks, Instagram login page (look only)
```

The smoke test opens Notepad, opens a **new tab** (Notepad restores your earlier tabs, which must stay untouched), types `Merhaba ğüşıöç`, `ctrl+a`, checks the text by copying it back, takes a screenshot, verifies that `move` lands on the mapped screen pixel, drags across the text and checks the selection is a prefix of it, checks that a denylisted window is refused, empties and closes the tab and the window, then checks the kill switch with a second server instance. Screenshots are written to `test/out/`.

## Chrome end-to-end test (`npm run chrome-test`)

Opens Chrome the way a person does: it middle-clicks the pinned Chrome button on the taskbar (found read-only through UI Automation by `test/taskbar-button.ps1`, clicked through the server's `click` on the taskbar window). A middle-click starts a **new window** and does not focus or minimise the windows you already have open. The test then targets only that new window (the hwnd that was not there before), types `https://www.google.com/?hl=en` in the address bar, types `Merhaba dunya hava durumu Istanbul` into the search box, presses Enter, and checks:

- window title contains the query, and the URL (read with `ctrl+l`, `ctrl+c`) is `google.*/search?q=...hava+durumu...`
- a screenshot of the results window is returned (`test/out/chrome-results.png`)
- the page text, copied with `ctrl+a`, `ctrl+c` and read back from the clipboard (no OCR), is non-empty and contains the query terms (`test/out/chrome-results.txt`)

At the end only that window is closed (`WM_CLOSE`).

Limits:

- The new window uses your normal Chrome profile, so the search lands in your history and your cookies decide whether a Google consent screen shows. The test fails with a clear message if it detects one instead of clicking blindly.
- Language: the URL pins `hl=en`, so labels are English; result text can still be Turkish.
- Result titles are heuristic; the title/URL/text checks are the real assertions.
- Needs the taskbar Chrome button to be pinned or running, an unlocked screen, and Chrome not elevated.

## Instagram login-page test (`npm run instagram-test`)

Opens a new Chrome window with a global middle-click on the taskbar button, then:

- scroll check on a local `data:` page (4000x3000 colour field): vertical and horizontal scroll, in global coordinates, both directions, verified by pixel colour from `screenshot_screen` regions
- opens `https://www.instagram.com/accounts/login/`, waits for the title, saves a global screenshot (`test/out/instagram-login.png`) and reads the page through UI Automation (`test/ui-text.ps1`, read-only, no field values): asserts Instagram in title/URL/page, a username field, a password field and a log-in button
- scrolls the page down and up, then closes only the window it opened

It never types into or clicks anything on Instagram (the only text typed is the two addresses; the test asserts that from the action log), never logs in, and never touches a cookie banner or account chooser. Screenshots stay local in `test/out/` (git-ignored).

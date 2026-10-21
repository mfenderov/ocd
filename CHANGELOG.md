# Changelog
All notable changes to this project will be documented in this file. See [conventional commits](https://www.conventionalcommits.org/) for commit guidelines.

- - -
## v0.21.0 - 2026-10-21
#### Features
- (**box**) the tunnel config serves the old names and the new ones - (6ed8c87) - mfenderov
- the home box serves the names every box follows - (da44862) - mfenderov
#### Bug Fixes
- (**box**) the tunnel and the daemon come back with what the onboarding wrote - (1f6fb9b) - mfenderov
- (**box**) the box's own tunnel is the one it serves - (18ca3d9) - mfenderov
- (**box**) the repair prefers the box's own name - (77a763c) - mfenderov
- (**box**) the merge never drops what it cannot reproduce - (6a7394f) - mfenderov
#### Miscellaneous Chores
- (**box**) the tunnel runs by its id, and the docs name the new hosts - (7d13606) - mfenderov

- - -

## v0.20.0 - 2026-10-21
#### Features
- (**box**) the sweep pushes audit rows, newest-watermark first - (c0b516d) - mfenderov
- (**worker**) /faudit answers from the brain's own history - (c6d41d1) - mfenderov
- (**worker**) every enrolment leaves with its DNS ensured - (9485b8f) - mfenderov
- (**worker**) the brain writes the two CNAMEs a box needs - (a8a23e2) - mfenderov
- the brain owns the DNS, the history and the bot - (159c85c) - mfenderov
- <span style="background-color: #d73a49; color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 0.85em;">BREAKING</span>the Go bot is gone; the brain owns Telegram - (0780d92) - mfenderov
#### Bug Fixes
- (**box**) the box's DNS write must not abort on an existing record - (8c7d553) - mfenderov
- (**box**) the audit watermark is anchored to its row, not its rowid - (636c346) - mfenderov
- (**box**) the watermark only moves forward, and a reset trail does not silence the push - (e7116c7) - mfenderov
- (**box,worker**) the review's small findings, before the merge - (e2ab695) - mfenderov
- (**box,worker**) the DNS failure reaches the owner - (bc539e7) - mfenderov
- (**worker**) one seq-reset ping per box, not one per heartbeat - (f59fb6e) - mfenderov
- (**worker**) the claim carries the box's tunnel, and the DNS call has a deadline - (1f11a6f) - mfenderov
- (**worker**) the DNS writer refuses what it cannot read - (7f1059e) - mfenderov
#### Documentation
- (**box**) the prune comment must match the repair that exists - (7f46614) - mfenderov
- the brain owns the DNS it enrols, and the runbook tells the truth - (4252756) - mfenderov
- the brain owns the bot, the DNS and the history - (bb7d604) - mfenderov
#### Tests
- (**box**) the prune keeps the newest row, so a watermark never goes stale - (570eb7c) - mfenderov
- (**worker**) the history keeps the taint the box pushed with - (7b337bf) - mfenderov
#### Miscellaneous Chores
- (**box**) the Go bot's dead bookkeeping is gone - (d220564) - mfenderov
- (**worker**) the brain's zone id for the DNS it owns - (6a6578b) - mfenderov

- - -

## v0.19.0 - 2026-10-21
#### Features
- (**box**) tell the brain which tunnel this box uses - (7176636) - mfenderov
- (**box**) report the OpenCode status and the links that died - (1b4cc0d) - mfenderov
- (**box**) push link events to the brain without blocking the tap - (dc0ebaf) - mfenderov
- (**worker**) the brain notices a silent box, once, and probes it directly - (7d9abd7) - mfenderov
- (**worker**) the brain owns the links and edits the messages it handed out - (d9700bd) - mfenderov
- (**worker**) the fleet board and the link menu, with working buttons - (b4e5204) - mfenderov
- (**worker**) the brain answers the fleet commands - (5378511) - mfenderov
- (**worker**) the brain answers Telegram, owner chat only, once per update - (d78611a) - mfenderov
- (**worker**) a Telegram client for the brain - (0de33e2) - mfenderov
- the cutover script that hands Telegram to the brain - (8efcc12) - mfenderov
#### Bug Fixes
- (**box**) the sweep touches only the brain's own links - (4d26ca0) - mfenderov
- (**box**) report each dead link to the brain exactly once - (28345d1) - mfenderov
- (**worker**) the brain keeps the tunnel id, and a tap is always answered - (d03d7ea) - mfenderov
- (**worker**) a retired box is not offline, and a broken probe never calls one dead - (8465231) - mfenderov
- (**worker**) the brain takes the events even without Telegram, and asks the bearer first - (16ed710) - mfenderov
- (**worker**) one payload parser, one clock, and a tap that never spins - (abca0ea) - mfenderov
- (**worker**) a chat edit answers with the edited Message, not with true - (c012f57) - mfenderov
- (**worker**) the enrollment ping shares the Telegram client, and the client leaks no token - (84a5a79) - mfenderov
- the enroll comment says what is true about the tunnel id - (4a36390) - mfenderov
- the status relay's exec dies with its deadline, so no goroutine leaks - (c1af6c7) - mfenderov
- the brain's pre-flight is not a session, so a login spends one slot - (22e5c6f) - mfenderov
- the cutover script hides the secret, demands https, and reads ok first - (911d448) - mfenderov
- the webhook must ask for callback queries, and the env loader must read single quotes - (2cdf648) - mfenderov
#### Tests
- (**tg**) pin the webhook to the callback queries the buttons need - (5446bb3) - mfenderov

- - -

## v0.18.3 - 2026-10-20
#### Bug Fixes
- a terminal check that means terminal - (b9b8bea) - mfenderov

- - -

## v0.18.2 - 2026-10-20
#### Bug Fixes
- a box that answers is not offline, and the bot's paste must be accepted - (2aceab7) - mfenderov

- - -

## v0.18.1 - 2026-10-20
#### Bug Fixes
- (**worker**) a box behind a dead tunnel is unreachable, not refusing - (aabeb9b) - mfenderov

- - -

## v0.18.0 - 2026-10-20
#### Features
- onboarding takes the name and the code as arguments - (15547e5) - mfenderov
#### Documentation
- architecture map (components, flows, schema, secrets) - (1aa3fb9) - mfenderov

- - -

## v0.17.4 - 2026-10-20
#### Bug Fixes
- env file paths must be absolute, and repair reads real hostnames - (1895c01) - mfenderov

- - -

## v0.17.3 - 2026-10-19
#### Bug Fixes
- (**worker**) clear all 12 dependabot advisories - (5624dfb) - mfenderov

- - -

## v0.17.2 - 2026-10-19
#### Bug Fixes
- discover the OpenCode service port instead of assuming 49374 - (5befdda) - mfenderov

- - -

## v0.17.1 - 2026-10-19
#### Bug Fixes
- boxes need OCD_PAIR_OPEN or every tap link 401s - (44b0b79) - mfenderov

- - -

## v0.17.0 - 2026-10-19
#### Features
- ocd repair fixes a box wired by an older build - (195ecc7) - mfenderov

- - -

## v0.16.0 - 2026-10-19
#### Features
- /link is the box menu - (17c89eb) - mfenderov

- - -

## v0.15.0 - 2026-10-19
#### Features
- button-driven Telegram UI (fleet board + one-tap links) - (685a5ee) - mfenderov
#### Bug Fixes
- make the onboarding wiring test hermetic - (88c491e) - mfenderov
- onboard wires tap link, pair link and UI port correctly - (dcf8027) - mfenderov

- - -

## v0.14.3 - 2026-10-19
#### Bug Fixes
- ocd service install refreshes the plist - (1d834b8) - mfenderov

- - -

## v0.14.2 - 2026-10-19
#### Bug Fixes
- report enroll trust so a missing scope says so - (d0837e1) - mfenderov

- - -

## v0.14.1 - 2026-10-19
#### Bug Fixes
- launchd env (HOME, PATH) and atomic onboarding - (d839853) - mfenderov

- - -

## v0.14.0 - 2026-10-19
#### Features
- ocd service install/uninstall/status - (a812906) - mfenderov

- - -

## v0.13.3 - 2026-10-19
#### Bug Fixes
- derive scope validation from ALL_SCOPES - (17e4201) - mfenderov
#### Documentation
- runbooks match the one-command onboarding - (a4441de) - mfenderov

- - -

## v0.13.2 - 2026-10-19
#### Bug Fixes
- owner-issued enroll codes only (closes silent box takeover) - (66bb87e) - mfenderov

- - -

## v0.13.1 - 2026-10-19
#### Bug Fixes
- move the box API off /admin (Cloudflare challenges that path) - (f2c50db) - mfenderov

- - -

## v0.13.0 - 2026-10-19
#### Features
- name the cause when bot protection blocks the box relay - (80fe39d) - mfenderov

- - -

## v0.12.0 - 2026-10-19
#### Features
- bare 'ocd' is the whole onboarding - (9151752) - mfenderov

- - -

## v0.11.0 - 2026-10-19
#### Features
- one-command onboarding with re-run guard and auto-login - (10c9228) - mfenderov

- - -

## v0.10.1 - 2026-10-19
#### Bug Fixes
- onboard reruns pass through identical tunnel config - (0c4e4e5) - mfenderov

- - -

## v0.10.0 - 2026-10-19
#### Features
- Telegram-first onboarding, form asks almost nothing - (6ce4e8e) - mfenderov

- - -

## v0.9.0 - 2026-10-19
#### Features
- single-command onboard — tunnel, service, self-loading env - (a54b413) - mfenderov

- - -

## v0.8.3 - 2026-10-19
#### Bug Fixes
- clear macOS quarantine on cask install - (85c146a) - mfenderov

- - -

## v0.8.2 - 2026-10-19
#### Bug Fixes
- enroll tolerates heartbeat-suffixed worker URL - (cece393) - mfenderov

- - -

## v0.8.1 - 2026-10-19
#### Bug Fixes
- verify release assets via gh download, not browser URLs - (6b76adc) - mfenderov

- - -

## v0.8.0 - 2026-10-19
#### Features
- single-command tunnel provisioning in onboard - (60da9c5) - mfenderov
#### Bug Fixes
- hermetic cloudflared login check in onboard tests - (6be8821) - mfenderov

- - -

## v0.7.0 - 2026-10-18
#### Features
- typed enroll codes replace the approve tap - (c64919e) - mfenderov

- - -

## v0.6.0 - 2026-10-18
#### Features
- ocd onboard TUI for single-command box enrollment - (8935f54) - mfenderov

- - -

## v0.5.1 - 2026-10-18
#### Bug Fixes
- fleet client tolerates heartbeat-suffixed worker URL - (eb8259f) - mfenderov

- - -

## v0.5.0 - 2026-10-18
#### Features
- fleet scope for the Telegram bot - (74d12d9) - mfenderov

- - -

## v0.4.0 - 2026-10-18
#### Features
- remove web console, Telegram is the UI - (83d3de6) - mfenderov

- - -

## v0.3.0 - 2026-10-18
#### Features
- self-releasing pipeline via cog bump and release dispatch - (4536316) - mfenderov
#### Bug Fixes
- cog branch whitelist matches master branch - (430050c) - mfenderov

- - -

Changelog generated by [cocogitto](https://github.com/cocogitto/cocogitto).
| Key | File | What the reader must learn | Size limit |
| --- | --- | --- | --- |
| route_base_url_invalid | packages/augurd/src/adapters/api.ts | The named route needs a valid baseUrl option. Preserve the route label and option name. | 160 characters |
| route_key_missing | packages/augurd/src/adapters/api-call.ts | The route key or environment key is absent. A Claude API route can also use the provider key saved in Settings. Preserve the names supplied as parameters. | 240 characters |
| claude_api_test_failed | packages/core/src/providers/claude-api.ts | The explicit key test failed. No credential or response text belongs in the error. | 120 characters |
| claude_api_configuring_fix | docs/configuring.md | Usage refresh does not test this key. Test key checks it explicitly, and its result lasts for the current session. | 80 words |
| claude_api_changelog_fix | CHANGELOG.md | Usage refresh stays offline for this provider; route planning validates baseUrl, and requests accept a trailing v1 path. | 50 words |
| node_level_present | packages/view-model/src/node-view.ts | The entry already has a level for this activity, so a catalog addition cannot change it. | 120 characters |
| node_add_refused | packages/view-model/src/node-view.ts | The selected catalog entry cannot join this activity under the current rules. | 120 characters |
| node_view_readme_fix | README.md | Copy and suggest each have one undo step. Copy skips missing source levels. Catalog additions preserve existing levels and respect refusals. | 60 words |
| node_view_editing_fix | docs/configuring.md | Copy and suggest group their history, missing source levels preserve inheritance, and positive scores remain visible. | 80 words |
| node_view_history_changelog_fix | CHANGELOG.md | Catalog adds respect existing levels and refusals, copy and suggest undo together, and small positive shares stay visible. | 50 words |

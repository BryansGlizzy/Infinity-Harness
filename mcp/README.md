# MCP servers on this machine

What lives here, and how Roblox Studio (on Vinegar) is wired to Infinity Harness. Everything under "Verified" was checked on
**2026-11-13**: Vinegar (Flatpak), Studio `0.747.0.7471481`, `@chrrxs/robloxstudio-mcp` **3.4.3**, `rbxsync` **1.4.0**.

| Path | What it is |
|---|---|
| `_installed/` | The pinned Roblox Studio MCP server (`npm install --prefix mcp/_installed --ignore-scripts @chrrxs/robloxstudio-mcp@3.4.3`). Not in git; the **Install** button in Settings → MCP recreates it. This is what runs. |
| `robloxstudio-mcp/` | A source checkout of the same project, for reading. Not run. |

Both are ignored by git (see `.gitignore`); this README is the one exception.

## How the pieces fit

```
Studio (Vinegar/Wine)                     Infinity Harness daemon (host)
 ├─ MCP Server plugin  ──────────────────►  Roblox Studio MCP server   :58741   (hub: agents reach it via /hub/roblox-studio)
 └─ RbxSync plugin     ──────────────────►  rbxsync serve              :44755   (run by the add-on, in the board's folder)
                                             rbxsync-mcp               (stdio, via the hub: sync_to_studio, extract_game)
```

- The **Roblox add-on** (MCP tab, off by default, direct boards only) starts `rbxsync serve` in the board's folder and switches on both
  MCP servers. Agents never see the servers' addresses or keys; they go through the hub.
- The **Links chip** under the goal bar shows live whether Studio's two plugins and the sync process are connected.
- Scripts are files in the board folder (`src/<Service>/…`); `sync_to_studio` pushes them (RbxSync's `autoSync` is off in
  `rbxsync.json`). Everything else (inspect/change the live place, run Luau, playtest, logs) goes through the Studio server.
- More: [docs/user-guide.md](../docs/user-guide.md) §6a, [docs/mcp-hub-plan.md](../docs/mcp-hub-plan.md).

## Setup on a fresh machine

1. Start the daemon (`pnpm start`). The Roblox Studio server starts with it on `:58741`.
2. Open the board's **MCP** tab, press **Install** if the server shows "not installed", then switch the **Roblox Studio** add-on on.
3. Make sure the plugin file is in **Studio's** plugins folder (next section). The harness does this for you when it can find the folder.
4. **Fully close and reopen Studio** (it loads plugins only at startup), open your place, press **MCP Server** in the plugin toolbar and
   **Connect** in the RbxSync plugin.
5. The **Links** chip turns green.

## The thing that cost a day: where Studio reads plugins

On Vinegar, Studio loads local plugins from the folder **inside the Wine prefix**:

```
~/.var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users/<you>/AppData/Local/Roblox/Plugins
```

That is what Studio's own *Plugins → Plugins Folder* opens. It is **not** `…/vinegar/appdata/Roblox/Plugins`, where RbxSync keeps its
real file. RbxSync loads only because the prefix folder holds a **symlink** to that file; a plugin placed only in `appdata/` is never
scanned, and nothing in Studio says so. The MCP plugin sat in `appdata/` for six Studio runs, never loaded, and the Studio server was
unreachable the whole time.

Fix used here: `MCPPlugin.rbxmx` in the prefix folder (a symlink to the copy in `appdata/Roblox/Plugins/`, like RbxSync's). The harness's
installer targets the prefix folder (`vinegarPluginsDir()` in `apps/daemon/src/mcp-hub.ts`, which prefers it and falls back to `appdata/`
only when there is no prefix). A native (non-Flatpak) Vinegar uses `~/.local/share/vinegar/...` with the same layout.

## Verified: what "working" looks like

Check these three, in this order, instead of guessing:

1. **Studio loaded the plugin.** In the newest `~/.var/app/org.vinegarhq.Vinegar/data/vinegar/appdata/Roblox/logs/*Studio*_last.log`:
   `loadPlugin user_MCPPlugin.rbxmx took … msec [dm=Edit …]`. No such line means Studio never read it (wrong folder).
   (`PluginDockWidgetRelay … Failed Empty` warnings next to it are normal; built-in plugins log them too.)
2. **The bridge sees it.** `curl -s localhost:58741/health` → `"pluginConnected": true`, `"instanceCount": 1`, and the place's name.
3. **The harness agrees.** The Links chip is green; `ih addon` lists *Studio MCP plugin → running (1 place connected)* and
   *RbxSync plugin → running (place connected, syncing <board folder>)*.

Seen on 2026-11-13: a place connected, the sync serving the board's folder on `:44755`.

## Troubleshooting

| Symptom | Cause and check |
|---|---|
| Studio dot red, `pluginConnected: false` | Log has no `loadPlugin user_MCPPlugin…` → plugin not in Studio's prefix folder: link it there, restart Studio. Log has it → open a place, press **MCP Server** in the toolbar, check `:58741` answers. The add-on's status names the missing file and folder. |
| RbxSync dot red | Press **Connect** in the RbxSync plugin. If it connects but "syncing" a different folder, a hand-started `rbxsync serve` (VS Code, a terminal) is the one answering: stop it. |
| "Port 44755 is already in use" when switching the add-on on | Something else holds the sync port. The harness will not guess which folder it serves: stop it. `IH_RBXSYNC_PORT` moves the harness's sync, but Studio's RbxSync plugin only looks on 44755. |
| Studio crashed | The Studio server stays up; the sync process is restarted by the supervisor (up to 5 times, with backoff). Both plugins must reconnect: reopen the place, press **MCP Server** and **Connect**. Cards that need the add-on wait (Settings → Tools → *Hold cards…*) and start by themselves when the chip is green. |
| Plugin refused after an update | The plugin and server versions must match exactly (both 3.4.3). Updating the server re-installs its plugin on start; restart Studio afterwards. Keep one copy of the plugin file. |
| Agents say Studio logs or other folders are refused | By design. Use the `get_runtime_logs` tool; ask `addon_status` instead of probing the machine. |
| `get_connected_instances` returns nothing | Same as the first row: no plugin connection. |

## Tools agents are offered

Every tool offered costs context on every step, so the Studio server offers 27 of its 50 tools and RbxSync only
`sync_to_studio` and `extract_game` (the rest duplicate the Studio server's or overlap the harness's git). Change it per tool in
Settings → MCP. `manage_instance` (launch/close Studio) is hidden: the server's own docs say its Wine launcher cannot work from a Flatpak.

## Testing without disturbing your Studio

Never run a real `rbxsync serve` on `44755` for experiments while Studio is open: the RbxSync plugin may connect and sync an empty
folder into your place. Use `IH_RBXSYNC_PORT=44791` (and a copy of the project folder) for scratch daemons. A scratch daemon's copy of the
Studio server falls into proxy mode behind the real one on `:58741`; do not kill that listener without checking whose it is.

## Not verified

- Behaviour across a Studio crash was inferred from the supervisor's design and the first run, not reproduced since the plugin fix.
- Updating the server while Studio is open (the installer re-copies the plugin file; Studio must restart to pick it up).

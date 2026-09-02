# Pi IDE Bridge

Pi IDE Bridge connects the Pi coding agent to VS Code on demand. Run `/ide` when you want Pi to receive the current editor state and access VS Code diagnostics; run `/ide disconnect` when you want to end the connection. File edits are always accepted and are never paused for approval.

## What you get

- **Manual connection control** — Pi connects only after you run `/ide`. There is no automatic connection or retry loop.
- **Always-accepted edits** — `edit` and `write` calls proceed immediately without an approval prompt or keyboard toggle.
- **Editor context** — while connected, Pi knows which files you have open, which is active, where your cursor is, and what text you have selected.
- **Diagnostics on demand** — while connected, Pi can query VS Code's current errors and warnings via the `get_ide_diagnostics` tool, scoped to the active file, a specific file, or all open files.

## Installation

### Step 1 — Install the Pi extension

```
pi install npm:@m4riok/pi-ide-bridge
```

Restart your Pi session after installing.

### Step 2 — Install the VS Code companion

In Pi, run:

```
/ide install
```

Then connect explicitly:

```
/ide
```

### Manual VS Code install

Search for **Pi IDE Bridge** in the VS Code Extensions panel, or run:

```
ext install m4riok.pi-ide-bridge-vscode
```

## Commands

| Command | What it does |
|---------|-------------|
| `/ide` | Connect to the matching VS Code window |
| `/ide status` | Report the current connection state without connecting |
| `/ide disconnect` | Disconnect from VS Code and clear editor context |
| `/ide install` | Install the VS Code companion extension |
| `/ide context` | Show the current editor context Pi is seeing |
| `/ide diagnostics` | Show diagnostics for the active file |
| `/ide diagnostics all` | Show diagnostics across all open files |
| `/ide diagnostics file <path>` | Show diagnostics for a specific file |

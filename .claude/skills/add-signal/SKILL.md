---
name: add-signal
description: Add Signal as a channel using signal-cli. Can replace WhatsApp or run alongside it.
---

# Add Signal Channel

This skill activates and configures Signal support in NanoClaw using the signal-cli REST API. The codebase already includes the Signal channel implementation; this skill walks through the sidecar container setup, account linking, and registration. Users can choose to:

1. **Replace WhatsApp** - Use Signal as the only messaging channel
2. **Add alongside WhatsApp** - Both channels active simultaneously

## Prerequisites

### 1. Container Runtime

Signal-cli runs as a sidecar container using `bbernhard/signal-cli-rest-api`. Either Docker or Apple Container works.

### 2. Signal Account for the Bot

**Important:** Signal doesn't have separate "bot accounts" like Telegram. The bot operates as a linked device on a real Signal account, similar to Signal Desktop.

You need to decide which Signal account the bot will use:

| Approach | Pros | Cons |
|----------|------|------|
| **Dedicated number** (Recommended) | Bot has its own identity; clear separation | Requires a second SIM, eSIM, or VoIP number |
| **Your personal number** | No extra number needed | Bot operates as "you"; messages appear from your number |

For a dedicated bot account, you can use:
- A second SIM card or eSIM
- Google Voice, Twilio, or similar VoIP number
- A prepaid SIM

The bot will link to whichever Signal account you choose as a secondary device. Signal allows up to 4 linked devices. If you've already linked tablets, desktops, or other devices, you may need to unlink one first via Signal Settings > Linked Devices.

## Questions to Ask

Before making changes, detect available container runtimes, then use the `AskUserQuestion` tool to gather configuration.

### Step 1: Detect container runtimes

```bash
HAS_APPLE=$(which container 2>/dev/null && echo "yes" || echo "no")
HAS_DOCKER=$(which docker 2>/dev/null && echo "yes" || echo "no")
```

- If neither is found, stop and tell the user they need Docker or Apple Container installed first.
- If only one is found, use it automatically (no question needed).
- If both are found, include the runtime question in the batch below.

### Step 2: Ask user preferences

Use `AskUserQuestion` with the following questions. Include all applicable questions in a single call (max 4 questions per call).

**Question 1 (only if both runtimes detected)** - **header**: "Runtime", **question**: "Which container runtime should run the signal-cli sidecar?"
   - Option 1: "Apple Container (Recommended)" - description: "Matches the runtime used for NanoClaw's agent containers. Requires a launchd plist for auto-restart."
   - Option 2: "Docker" - description: "Supports docker-compose and --restart policies. Use this if your NanoClaw fork already uses Docker for agents."

**Question 2** - **header**: "Mode", **question**: "Should Signal replace WhatsApp or run alongside it?"
   - Option 1: "Replace WhatsApp" - description: "Signal becomes the only channel (SIGNAL_ONLY=true). WhatsApp will not start."
   - Option 2: "Run alongside" - description: "Both Signal and WhatsApp channels will be active simultaneously."

**Question 3** - **header**: "Sender filter", **question**: "Within registered chats, should the bot respond to all members or only specific phone numbers?"
   - Option 1: "All members (Recommended)" - description: "Anyone in a registered chat can trigger the agent. Unregistered chats are always ignored regardless."
   - Option 2: "Specific numbers only" - description: "Only messages from approved phone numbers are processed, even within registered chats. Useful for shared groups where only you should trigger the agent."

### Step 3: Follow-up questions (if needed)

If the user selected "Specific numbers only", ask for comma-separated phone numbers in E.164 format (e.g., `+61412345678,+61498765432`).

### Step 4: Ask for the bot's phone number

Ask clearly which Signal account the bot will operate from. Use `AskUserQuestion`:

**Question** - **header**: "Bot's number", **question**: "What phone number is the bot's Signal account registered to? This is the number people will message to reach the bot, and messages from the bot will appear to come from this number."
   - Option 1: "Dedicated number" - description: "I have a separate number for the bot (second SIM, eSIM, or VoIP). I'll enter it."
   - Option 2: "My personal number" - description: "The bot will operate as me, using my personal Signal account."

If they choose "Dedicated number", ask them to enter it in E.164 format (e.g., `+61412345678`).

If they choose "My personal number", ask them to confirm their number in E.164 format.

### Design notes

NanoClaw's security model already restricts message delivery to registered chats only. The sender filter is an additional layer, not the primary access control. Registration is managed by the main group's admin via IPC.

When recommending the container runtime, prefer Apple Container if the upstream NanoClaw codebase uses it for agent containers (consistency), or Docker if the user's fork has already been converted to Docker via the `/convert-to-docker` skill.

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). Each messaging platform implements this interface. Key files:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/signal.ts` | `SignalChannel` class |
| `src/signal/client.ts` | WebSocket/REST client for signal-cli-rest-api |
| `src/signal/daemon.ts` | Spawns local signal-cli daemon (not used with sidecar) |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |

The Signal channel follows the same pattern as WhatsApp and Telegram:
- Implements `Channel` interface (`connect`, `sendMessage`, `ownsJid`, `disconnect`, `setTyping`)
- Delivers inbound messages via `onMessage` / `onChatMetadata` callbacks
- The existing message loop in `src/index.ts` picks up stored messages automatically

## Security Considerations

### Trust Model

The signal-cli-rest-api container exposes an **unauthenticated HTTP API** on localhost. This is a deliberate design choice by the upstream project to keep the container simple; authentication is expected to be handled externally if needed.

**What this means:**
- Any process running on the host can send messages via `curl http://localhost:8080/...`
- Any process can read incoming messages via the WebSocket endpoint
- The API provides full access to the linked Signal account

**Who can access the API:**

| Scenario | Can access? |
|----------|-------------|
| Your user account processes | Yes |
| Other users on a shared system | Yes (same localhost) |
| Remote network attackers | No (bound to 127.0.0.1) |
| Malware running as your user | Yes |

For a **single-user macOS machine**, this is generally acceptable. The localhost binding prevents remote access, and any malware with local access could likely compromise Signal through other means anyway.

**Note on WebSocket transport**: NanoClaw connects to signal-cli via WebSocket (`ws://`) which is unencrypted. However, this connection is localhost-only and never leaves your machine. The Signal Protocol's end-to-end encryption happens inside signal-cli, so messages to/from Signal's servers are always encrypted regardless of the local transport.

For **multi-user systems or higher-security deployments**, consider adding authentication via a reverse proxy (see Hardening below).

### Key Material Protection

The signal-cli data directory contains cryptographic keys that provide full access to your linked Signal account. Protect this directory:

**Apple Container (bind mount):**
```bash
chmod 700 ~/.local/share/signal-cli-container
```

**Docker (named volume):**
Docker volumes are owned by root and not directly accessible, but anyone with Docker socket access can mount and read them.

**Backup security:** Backups of this directory contain the same sensitive key material. Store backups encrypted and restrict access.

### Hardening (Optional)

For deployments requiring authentication, two options exist:

**Option 1: Reverse proxy with authentication**

Add nginx, Caddy, or Traefik in front of the signal-cli container with Basic Auth or OAuth:

```nginx
# Example nginx config
location /signal-api/ {
    auth_basic "Signal API";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://127.0.0.1:8080/;
}
```

Then update `SIGNAL_HTTP_HOST` and `SIGNAL_HTTP_PORT` to point to your proxy, and modify `src/signal/client.ts` to include authentication headers.

**Option 2: Use secured-signal-api wrapper**

The [secured-signal-api](https://github.com/CodeShellDev/secured-signal-api) project wraps signal-cli-rest-api with:
- Bearer, Basic, or query-based authentication
- Configurable rate limiting
- Endpoint restrictions (block sensitive endpoints like `/v1/qrcodelink`)
- IP filtering

This requires modifying NanoClaw to send authentication headers with each request.

### Rate Limiting

Signal enforces strict anti-spam measures. Violations can result in:
- CAPTCHA challenges (requires manual completion on Signal Desktop)
- Temporary sending restrictions
- In severe cases, account suspension

**Best practices:**
- Avoid adding the bot to high-traffic groups
- Don't send bulk messages in rapid succession
- If rate limited, wait several hours before retrying
- CAPTCHA completion only helps future sends; already-failed messages are not retried automatically

### Agent Isolation

The NanoClaw orchestrator acts as a trust boundary between agent containers and the Signal API. Agents communicate via IPC files, not directly to signal-cli. This means:

- A compromised agent can request the orchestrator to send messages (by design)
- A compromised agent cannot directly access signal-cli or bypass the orchestrator
- The container around signal-cli isolates its attack surface (Java runtime, native libraries) from the host

The primary access control is **chat registration**. Only messages to/from registered chats are processed. The `SIGNAL_ALLOW_FROM` filter provides an additional layer within registered chats.

## Implementation

### Step 1: Start signal-cli Container

Pin to a specific version to avoid breakage from upstream changes. Signal-cli must stay compatible with Signal's servers, and `latest` can introduce breaking changes without warning.

#### Docker

Create or update `docker-compose.yml` to include the signal-cli service:

```yaml
services:
  signal-cli:
    image: bbernhard/signal-cli-rest-api:0.97
    environment:
      - MODE=json-rpc
    volumes:
      - signal-cli-data:/home/.local/share/signal-cli
    ports:
      - "8080:8080"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  signal-cli-data:
```

Start the container:

```bash
docker compose up -d signal-cli
```

Or without docker-compose:

```bash
docker run -d \
  --name signal-cli \
  -e MODE=json-rpc \
  -v signal-cli-data:/home/.local/share/signal-cli \
  -p 8080:8080 \
  --restart unless-stopped \
  bbernhard/signal-cli-rest-api:0.97
```

#### Apple Container

Apple Container doesn't support compose files, so run the container directly. First, create a persistent directory for signal-cli data (Apple Container uses bind mounts, not named volumes) with restricted permissions:

```bash
mkdir -p ~/.local/share/signal-cli-container
chmod 700 ~/.local/share/signal-cli-container
```

Pull and run:

```bash
container pull bbernhard/signal-cli-rest-api:0.97
container run -d \
  --name signal-cli \
  -e MODE=json-rpc \
  -v ~/.local/share/signal-cli-container:/home/.local/share/signal-cli \
  -p 8080:8080 \
  bbernhard/signal-cli-rest-api:0.97
```

Note: Apple Container does not support `--restart` policies. If the container stops, you need to restart it manually or create a launchd plist to manage it (see Troubleshooting section below).

**Data persistence warning**: The signal-cli data directory holds your linked account registration and cryptographic keys. If this directory or volume is deleted (e.g., `docker volume prune`), you will lose the linked device and must re-link via QR code, which requires physical access to your phone.

After successfully linking, back up the data directory. These backups contain sensitive key material, so encrypt them:
- Docker (named volume): `docker run --rm -v signal-cli-data:/data -v $(pwd):/backup alpine tar czf /backup/signal-cli-backup.tar.gz -C /data . && gpg -c signal-cli-backup.tar.gz && rm signal-cli-backup.tar.gz`
- Apple Container (bind mount): `tar czf - -C ~/.local/share/signal-cli-container . | gpg -c > ~/signal-cli-backup.tar.gz.gpg`

### Step 2: Link Signal Account

First, wait for the signal-cli container to be ready by polling the health endpoint:

```bash
until curl -sf http://localhost:8080/v1/health > /dev/null 2>&1; do
  echo "Waiting for signal-cli to start..."
  sleep 2
done
echo "signal-cli is ready"
```

Then tell the user:

> I need you to link your Signal account:
>
> 1. Open this URL in your browser: **http://localhost:8080/v1/qrcodelink?device_name=nanoclaw**
> 2. Open Signal on your phone
> 3. Go to **Settings** > **Linked Devices** > **Link New Device**
> 4. Scan the QR code shown in the browser
>
> The QR code expires after a short time. If it fails, refresh the page to get a new one.

Wait for user to confirm linking is complete. Verify by checking the container logs:
- Docker: `docker logs signal-cli 2>&1 | tail -20`
- Apple Container: `container logs signal-cli 2>&1 | tail -20`

Look for "Successfully linked" or similar confirmation in the output.

**Note for users:** Linked devices don't receive message history from before linking. The bot will only see messages sent after this point. This is a Signal limitation, not a NanoClaw issue.

### Step 3: Install WebSocket Dependency

The Signal channel uses WebSocket to receive messages from the signal-cli container. Install the `ws` package:

```bash
npm install ws @types/ws
```

### Step 4: Verify Signal Support in Codebase

The NanoClaw codebase includes Signal channel support out of the box. Verify these files exist:
- `src/signal/client.ts` - WebSocket/REST client for signal-cli-rest-api
- `src/signal/daemon.ts` - Daemon spawning (not used with sidecar)
- `src/channels/signal.ts` - Channel implementation
- `src/config.ts` - Signal config exports (`SIGNAL_ACCOUNT`, `SIGNAL_HTTP_HOST`, etc.)

If any are missing, the NanoClaw version may predate Signal support. Update to a version that includes these files before continuing.

### Step 5: Update Environment

Since NanoClaw runs on the host (managed by launchctl/systemd), it connects to the signal-cli container via `localhost`. Add to `.env`:

```bash
# Signal Configuration
SIGNAL_ACCOUNT=+61412345678  # Your phone number in E.164 format

# Sidecar settings
SIGNAL_HTTP_HOST=127.0.0.1   # Use localhost since NanoClaw runs on host, not inside the container
SIGNAL_HTTP_PORT=8080
SIGNAL_SPAWN_DAEMON=0         # Don't spawn local daemon, use container sidecar

# Optional: Restrict who can message the bot
# SIGNAL_ALLOW_FROM=+61412345678,+61498765432

# Optional: Disable WhatsApp entirely
# SIGNAL_ONLY=true
```

**Important**: After modifying `.env`, sync to the container environment:

```bash
cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Step 6: Register a Signal Chat

After installing and starting, the user needs to register their Signal chat.

Tell the user:

> To register a Signal chat:
>
> 1. **For a group**: Send a message to the group from Signal. Note the group ID from the logs.
> 2. **For a DM**: Send a message to the bot's number from your Signal. Note your phone number.
>
> The JID format is:
> - Groups: `signal:group:<groupId>`
> - DMs: `signal:<phoneNumber>`
>
> Example: `signal:group:abc123def456` or `signal:+61412345678`

Registration uses the `registerGroup()` function in `src/index.ts`. From the main group, the agent can register new groups via IPC:

```typescript
// For DM (main group):
registerGroup("signal:+61412345678", {
  name: "Personal",
  folder: "main",
  trigger: "@Andy",
  added_at: new Date().toISOString(),
  requiresTrigger: false, // main group responds to all messages
});

// For group chat:
registerGroup("signal:group:abc123def456", {
  name: "Family Signal",
  folder: "family-signal",
  trigger: "@Andy",
  added_at: new Date().toISOString(),
  requiresTrigger: true, // only respond when triggered
});
```

### Step 7: Update launchd Environment (macOS)

**Important:** The launchd plist doesn't read `.env` files. You must add Signal environment variables directly to the plist.

Read the existing plist at `~/Library/LaunchAgents/com.nanoclaw.plist` and add these keys inside the `<dict>` under `EnvironmentVariables`:

```xml
<key>ASSISTANT_NAME</key>
<string>McClaw</string>
<key>SIGNAL_ONLY</key>
<string>true</string>
<key>SIGNAL_ACCOUNT</key>
<string>+YOUR_PHONE_NUMBER</string>
<key>SIGNAL_SPAWN_DAEMON</key>
<string>0</string>
<key>SIGNAL_HTTP_HOST</key>
<string>127.0.0.1</string>
<key>SIGNAL_HTTP_PORT</key>
<string>8080</string>
```

Replace the values with the user's actual configuration:
- `ASSISTANT_NAME`: The trigger word they chose
- `SIGNAL_ACCOUNT`: The bot's phone number
- `SIGNAL_ONLY`: `true` if replacing WhatsApp, `false` if running alongside
- `SIGNAL_ALLOW_FROM`: Add this key if they chose specific sender filtering

After editing, unload and reload the plist:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

For systemd (Linux), add the environment variables to the service file or use an EnvironmentFile directive pointing to `.env`.

### Step 8: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or for systemd:

```bash
npm run build
systemctl --user restart nanoclaw
```

### Step 9: Test

Tell the user:

> Send a message to your registered Signal chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` (or whatever trigger you set)
>
> Check logs: `tail -f logs/nanoclaw.log`

## Features

### Chat ID Formats

- **WhatsApp**: `120363336345536173@g.us` (groups) or `1234567890@s.whatsapp.net` (DM)
- **Telegram**: `tg:123456789` (positive for private) or `tg:-1001234567890` (negative for groups)
- **Signal**: `signal:group:<groupId>` (groups) or `signal:<phoneNumber>` (DM)

### Trigger Options

The bot responds when:
1. Chat has `requiresTrigger: false` in its registration (e.g., main group)
2. Message matches TRIGGER_PATTERN (e.g., starts with @Andy)

### Extended Features

Signal-specific capabilities available to the `SignalChannel` class:

- **Styled text**: `*italic*`, `**bold**`, `~strikethrough~`, `` `monospace` ``, `||spoiler||`
- **Polls**: Create, close, and track polls
- **Reactions**: Add/remove emoji reactions to messages
- **Message deletion**: Remote delete messages for everyone
- **Attachments**: Send base64-encoded file attachments
- **Quotes**: Reply to specific messages with quoted context
- **Mentions**: @mention users in messages
- **Read receipts**: Send read/viewed receipts
- **Typing indicators**: Show typing status

### Poll Support

The `SignalChannel` class provides poll methods:

```typescript
// Create a poll
const pollTimestamp = await signal.createPoll(jid, "What's for dinner?", ["Pizza", "Tacos", "Sushi"], true);

// Close a poll
await signal.closePoll(jid, pollTimestamp);
```

## Replace WhatsApp Entirely

If user wants Signal-only:

1. Set `SIGNAL_ONLY=true` in `.env`
2. Run `cp .env data/env/env` to sync to container
3. The WhatsApp channel is not created, only Signal
4. All services (scheduler, IPC watcher, queue, message loop) start normally
5. Optionally remove `@whiskeysockets/baileys` dependency (but it's harmless to keep)

## Troubleshooting

### Container not starting

Check logs:
- Docker: `docker compose logs signal-cli` or `docker logs signal-cli`
- Apple Container: `container logs signal-cli`

Common issues:
- Port 8080 already in use: Change `SIGNAL_HTTP_PORT` and container port mapping
- Volume permissions: Ensure the container runtime can write to the data directory

### Account not linking

1. Verify the container is running:
   - Docker: `docker ps | grep signal-cli`
   - Apple Container: `container list`
2. Verify the QR endpoint is reachable: `curl -sf http://localhost:8080/v1/qrcodelink?device_name=nanoclaw -o /dev/null && echo "OK" || echo "FAIL"`
3. If QR expired or scan failed, refresh the browser page to get a new QR code
4. If the endpoint returns an error, restart the container:
   - Docker: `docker restart signal-cli`
   - Apple Container: `container stop signal-cli && container start signal-cli`
5. Ensure your phone has internet connectivity
6. Check that your Signal app is up to date (older versions may reject the linking URI)

### Messages not received

1. Verify account is linked: Check container logs for "Successfully linked"
2. Verify chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal:%'"`
3. Check `SIGNAL_ALLOW_FROM` if configured: Your number must be in the list
4. Check NanoClaw logs: `tail -f logs/nanoclaw.log`

### Messages not sending to a group

Some Signal groups have admin-only messaging or other permission restrictions. If the bot can receive messages from a group but fails to send:

1. Check NanoClaw logs for send errors: `grep -i "signal.*error\|failed to send" logs/nanoclaw.log`
2. Verify the linked account has permission to send in that group (check group settings in Signal on your phone)
3. If the group is admin-only, you'll need to make the linked account an admin

### Rate limiting

Signal enforces strict rate limits on message sending. If you see HTTP 413, 429, or "rate limit" errors in the logs, the account is being throttled.

**Symptoms:**
- Messages fail to send with 4xx errors
- CAPTCHA challenge appears in Signal Desktop
- "Unable to send" errors in signal-cli logs

**Common causes:**
- Sending too many messages in quick succession
- Bot added to high-traffic groups
- Bulk operations (e.g., notifying many users)

**Recovery:**
1. Wait several hours before retrying (rate limits typically clear within 2-4 hours)
2. If prompted, complete the CAPTCHA challenge in Signal Desktop (Settings > Help > Troubleshooting > Request Account Data, then look for captcha prompt)
3. Note: CAPTCHA completion only helps future sends; already-failed messages are not automatically retried

**Prevention:**
- Avoid high-traffic groups where the bot might receive many messages
- Add delays between bulk sends (e.g., 1-2 seconds per message)
- Consider implementing client-side rate limiting in `src/signal/client.ts`

Repeated violations can result in temporary account restrictions or, in severe cases, account suspension.

### WebSocket connection failures

1. Verify signal-cli container is healthy: `curl http://localhost:8080/v1/health`
2. Verify the container is running in `json-rpc` mode: `curl http://localhost:8080/v1/about` should show `"mode":"json-rpc"`
3. Check `SIGNAL_HTTP_HOST` is set to `127.0.0.1` (for host-based NanoClaw) or the container name (if NanoClaw runs inside the container network)
4. The WebSocket connection auto-reconnects after 5 seconds on failure, so transient disconnects (e.g., container restarts) recover automatically. Check logs for persistent reconnection errors.
5. If you see "Signal SSE failed (404 Not Found)" errors, the container may be running in `native` mode instead of `json-rpc` mode. Recreate the container with `MODE=json-rpc`.

### Apple Container: auto-restart via launchd

Apple Container doesn't support `--restart` policies. To keep the signal-cli sidecar running across reboots, create a launchd plist at `~/Library/LaunchAgents/com.signal-cli-sidecar.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.signal-cli-sidecar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/container</string>
    <string>start</string>
    <string>signal-cli</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/signal-cli-sidecar.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/signal-cli-sidecar.log</string>
</dict>
</plist>
```

Load it with:

```bash
launchctl load ~/Library/LaunchAgents/com.signal-cli-sidecar.plist
```

Note: Verify the path to the `container` binary with `which container` and update the plist if it differs.

### Service conflicts

If running `bun run dev` while launchd service is active:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
bun run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Keeping signal-cli updated

Signal's servers require compatible client versions. The signal-cli-rest-api image should be updated every 2-3 months to maintain compatibility. Check the [GitHub releases](https://github.com/bbernhard/signal-cli-rest-api/releases) for new versions.

Docker:
```bash
docker compose pull signal-cli && docker compose up -d signal-cli
```

Apple Container:
```bash
container pull bbernhard/signal-cli-rest-api:<new-version>
container stop signal-cli && container rm signal-cli
# Re-run the container run command from Step 1 with the new version tag
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SIGNAL_ACCOUNT` | Your phone number (E.164 format: +61412345678) | Required |
| `SIGNAL_HTTP_HOST` | Daemon HTTP host | `127.0.0.1` |
| `SIGNAL_HTTP_PORT` | Daemon HTTP port | `8080` |
| `SIGNAL_SPAWN_DAEMON` | Set to `0` for external daemon (container sidecar) | `1` (spawn locally) |
| `SIGNAL_CLI_PATH` | Path to signal-cli binary (only if spawning locally) | `signal-cli` |
| `SIGNAL_ALLOW_FROM` | Comma-separated allowed phone numbers | Empty (allow all) |
| `SIGNAL_ONLY` | `true` to disable WhatsApp | `false` |


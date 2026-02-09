# Refactor Plan: Channel Extraction

Goal: Make the codebase adaptable so adding a messaging channel means touching 2-3 predictable places, not weaving into a monolith. No plugin system — hard-coded, but consistently structured.

---

## Step 0: Regression tests (before any code moves)

### Why

This refactor moves ~800 lines of logic between files. Nothing should change in behavior — same inputs, same outputs, same side effects. But "should" isn't confidence. Confidence comes from tests that capture the current behavior, run green before the refactor, and run green after.

These are characterization tests, not exhaustive unit tests. They exist to catch regressions during the refactor, not to be a permanent test suite (though many will remain useful afterward). The approach: test the contracts that the refactor must preserve — the input/output behavior of every function being moved or whose signature is changing.

### What to test and why

Each test targets logic that the refactor will relocate or restructure. If a test breaks after a refactor step, something changed that shouldn't have.

#### 1. Message formatting (`formatMessages`, `escapeXml`)

These pure functions move from `index.ts` to `router.ts`. Test that XML escaping works, messages format correctly, edge cases like empty arrays and special characters in sender names are handled.

*Why this matters:* Every agent invocation depends on correctly formatted XML prompts. A regression here means agents receive garbled context.

#### 2. Outbound formatting (prefix + internal tag stripping)

Currently `${ASSISTANT_NAME}: ${text}` is applied in `processGroupMessages`, the IPC watcher, and the task scheduler — each with its own `<internal>` stripping and `startsWith('tg:')` checks. After the refactor, `formatOutbound()` in `router.ts` does this once.

Test cases:
- Text with `<internal>...</internal>` blocks → stripped
- Text that is only internal tags → returns empty
- Multi-line internal tags
- Normal text → prefixed with assistant name

*Why this matters:* Three call sites are being unified into one. If the unified version handles any edge case differently, messages to users will look wrong.

#### 3. Trigger pattern matching

`TRIGGER_PATTERN` is the gatekeeper for non-main groups. Test:
- `@Andy hello` → matches
- `@andy hello` → matches (case insensitive)
- `hello @Andy` → doesn't match (must be at start)
- `@Andrew` → doesn't match (`\b` boundary)
- `@Andy's thing` → matches (word boundary before `'`)

*Why this matters:* Trigger logic moves into the router. A regression means groups either stop responding or respond to everything.

#### 4. DB round-trips (`storeMessage` → `getMessagesSince`)

The refactor unifies `storeMessage()` (Baileys format) and `storeMessageDirect()` (plain object) into a single `storeMessage(msg: NewMessage)`. Both current functions must produce identical rows in SQLite.

Test with an in-memory SQLite database:
- Store via `storeMessage()` (Baileys WAMessage), retrieve via `getMessagesSince()`, check fields
- Store via `storeMessageDirect()` (plain object), retrieve via `getMessagesSince()`, check fields
- Verify both paths produce identical results for the same logical message
- `getNewMessages()` with timestamp filtering
- `getMessagesSince()` excludes messages from the assistant itself
- `storeChatMetadata()` with and without a name parameter

*Why this matters:* This is the most dangerous part of the refactor. The DB is the backbone of message routing. If the unified `storeMessage` produces different rows than the current two functions, messages will be lost or duplicated.

#### 5. IPC authorization

`processTaskIpc` enforces security boundaries — main group can do anything, non-main groups can only operate on their own data. This moves to `src/ipc.ts`.

Test cases:
- Main group scheduling a task for another group → allowed
- Non-main group scheduling a task for itself → allowed
- Non-main group scheduling a task for another group → blocked
- Main group registering a new group → allowed
- Non-main group registering a group → blocked
- Main group pausing any task → allowed
- Non-main group pausing its own task → allowed
- Non-main group pausing another group's task → blocked

*Why this matters:* Authorization bugs are silent — they don't crash, they just let things through that shouldn't be let through (or block things that should work). These tests are the only way to know the security boundaries survived the move.

#### 6. JID routing

After the refactor, `routeOutbound` + `ownsJid` replaces the current `if (jid.startsWith('tg:'))` branches. Test the routing discrimination:
- `12345@g.us` → WhatsApp
- `12345@s.whatsapp.net` → WhatsApp
- `tg:12345` → Telegram
- Unknown JID format → error

Also test `getAvailableGroups()` filtering — currently has hardcoded JID pattern checks that will become `channels.some(ch => ch.ownsJid(jid))`.

*Why this matters:* Every outbound message and every group listing depends on correct JID routing. A regression means messages go to the wrong channel or groups disappear from the discovery list.

#### 7. GroupQueue concurrency invariants

GroupQueue isn't being restructured, but everything that feeds into it is. Test that the invariants hold:
- Only 1 container per group at a time
- Global concurrency limit respected
- Tasks are prioritized over messages
- Retry with exponential backoff on failure

*Why this matters:* The refactor changes how messages are enqueued (through the new channel callbacks). If the enqueueing contract changes subtly, the queue could double-process or drop messages.

### What NOT to test

- **WhatsApp/Telegram connections** — external dependencies, not being refactored
- **Container spawning** — `container-runner.ts` is unchanged
- **Mount security** — `mount-security.ts` is unchanged
- **Cron parsing** — delegated to `cron-parser`, not our logic
- **File-based IPC polling mechanics** — the filesystem polling loop is incidental, not behavioral

### Setup

```bash
npm i -D vitest
```

Minimal `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

### Test files

```
src/
  formatting.test.ts       # formatMessages, escapeXml, trigger pattern, outbound formatting
  db.test.ts               # storeMessage (both paths), getMessagesSince, getNewMessages,
                           #   storeChatMetadata, getAvailableGroups
  ipc-auth.test.ts         # processTaskIpc authorization checks
  group-queue.test.ts      # concurrency invariants, task priority, retry
  routing.test.ts          # JID ownership, outbound channel selection
```

### Approach for testing unexported functions

Some functions being tested (like `processTaskIpc`, `formatMessages`, `escapeXml`) are currently not exported from `index.ts`. Two options:

1. **Export them temporarily** — add `export` keyword, write tests, refactor moves them to new files where they'll be exported naturally. Clean approach for a refactor.
2. **Test through the public interface** — for functions like `processTaskIpc`, this means setting up DB state and verifying side effects. More realistic but more setup.

Option 1 is fine here. These functions will be exported from their new homes after the refactor anyway. Adding `export` now just means the tests don't need to change when the functions move — only the import paths change.

### Execution

1. Set up vitest (config, package.json script)
2. Write all test files against the current code
3. Run `npm test` — everything green
4. Proceed with refactor steps 1-8
5. After each step, update import paths in test files if needed, run `npm test`
6. All green at the end = refactor preserved behavior

---

## Step 1: Define Channel interface in `src/types.ts`

Add to the existing types file:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Whether to prefix outbound messages with the assistant name.
  // Telegram bots already display their name, so they return false.
  // WhatsApp returns true. Default true if not implemented.
  prefixAssistantName?: boolean;
}

// Callback type that channels use to deliver inbound messages
type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
// Callback for chat metadata discovery
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
```

No changes to existing types. Additive only.

---

## Step 2: Normalize `storeMessage()` in `src/db.ts`

Currently `storeMessage()` takes a raw Baileys `WAMessage` object and extracts content from it internally. The Telegram branch added a second function `storeMessageDirect()` that takes a plain object — proving the need for normalization. Unify both into a single function that accepts `NewMessage`.

Move the Baileys message extraction logic (pulling text from `message.conversation`, `message.extendedTextMessage`, etc.) into the WhatsApp channel, so it converts to `NewMessage` before calling `storeMessage()`.

**Before:**
```typescript
// db.ts — two functions doing the same thing
storeMessage(msg: WAMessage, chatJid: string, fromMe: boolean, pushName?: string)
storeMessageDirect(msg: { id, chat_jid, sender, sender_name, content, timestamp, is_from_me })
```

**After:**
```typescript
// db.ts — one function
storeMessage(msg: NewMessage)
```

The `NewMessage` type already has `id`, `chat_jid`, `sender`, `sender_name`, `content`, `timestamp` — everything the DB needs. Add `is_from_me: boolean` to `NewMessage` (it's currently not on the type but both store functions need it).

Also update `storeChatMetadata` to accept an optional `name` parameter. Telegram delivers chat names inline with messages; WhatsApp syncs them separately via `syncGroupMetadata`. Both patterns should work through the same function:

```typescript
storeChatMetadata(jid: string, timestamp: string, name?: string)
```

---

## Step 3: Create `src/channels/whatsapp.ts`

Extract all Baileys-specific code from `index.ts` into this file. It implements the `Channel` interface.

**Moves into this file:**
- `connectWhatsApp()` → becomes the channel's `connect()` method
- `sock` variable and all socket management
- `waConnected` flag → becomes internal state, exposed via `isConnected()`
- `outgoingQueue` and `flushOutgoingQueue()` → channel-level retry concern
- LID translation (`translateJid`, `lidToPhoneMap`)
- `setTyping()` — WhatsApp-specific UX
- `syncGroupMetadata()` — WhatsApp-specific concept (group name discovery)
- QR code / auth handling
- `messages.upsert` handler — converts Baileys messages to `NewMessage`, calls the `onMessage` callback
- `ensureContainerSystemRunning()` stays in index.ts (not channel-specific)

**Constructor takes callbacks:**
```typescript
constructor(opts: {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
})
```

**`ownsJid()` implementation:**
```typescript
ownsJid(jid: string): boolean {
  return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
}
```

**`sendMessage()` implementation:**
Wraps the existing logic (queue if disconnected, send via sock, re-queue on failure). The `${ASSISTANT_NAME}: ` prefix is NOT applied here — that's the router's job.

---

## Step 4: Create `src/router.ts`

Extract routing logic that's shared across channels.

**Moves into this file:**
- `formatMessages()` and `escapeXml()` — XML prompt formatting
- `formatOutbound(channel, text)` — strips internal tags, applies `${ASSISTANT_NAME}: ` prefix only if the channel wants it (checks `channel.prefixAssistantName`). Currently scattered across 3+ locations with ad-hoc `startsWith('tg:')` checks.
- `stripInternalTags(text)` — the `<internal>...</internal>` stripping (currently duplicated in processGroupMessages and task-scheduler)
- `routeOutbound(channels, jid, text)` — finds the right channel via `ownsJid()` and sends. Falls back to first connected channel if no match.
- `getAvailableGroups()` — the filter for valid JIDs currently grows per-channel (`jid.endsWith('@g.us') || jid.startsWith('tg:')`). Move it here and use `channels.some(ch => ch.ownsJid(jid))` instead.

```typescript
export function formatOutbound(channel: Channel, rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const prefix = channel.prefixAssistantName !== false ? `${ASSISTANT_NAME}: ` : '';
  return `${prefix}${text}`;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find(c => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

// Used by routeOutbound internally — also useful for callers
// that need to format before sending (e.g. IPC watcher, task scheduler)
export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find(c => c.ownsJid(jid));
}
```

---

## Step 5: Extract `src/ipc.ts`

Move `startIpcWatcher()` and `processTaskIpc()` out of index.ts.

**Interface:**
```typescript
export function startIpcWatcher(deps: {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (...) => void;
}): void
```

The `sendMessage` dependency here is `routeOutbound` wrapped with `formatOutbound` — so IPC messages go through the same outbound path as everything else.

---

## Step 6: Slim `index.ts` to orchestrator

After extraction, index.ts becomes the wiring layer (~200 lines):

```typescript
// 1. Init
ensureContainerSystemRunning();
initDatabase();
loadState();

// 2. Create channels
const whatsapp = new WhatsAppChannel({
  onMessage: (chatJid, msg) => {
    storeMessage(msg);
    // ... enqueue logic
  },
  onChatMetadata: (jid, ts) => storeChatMetadata(jid, ts),
  registeredGroups: () => registeredGroups,
});

const channels: Channel[] = [whatsapp];

// 3. Outbound routing
const send = (jid: string, text: string) => routeOutbound(channels, jid, text);

// 4. Start subsystems (independently, not inside connectWhatsApp)
await Promise.all(channels.map(c => c.connect()));
startMessageLoop(...);
startIpcWatcher({ sendMessage: send, ... });
startSchedulerLoop({ sendMessage: send, ... });
recoverPendingMessages();

// 5. Shutdown
process.on('SIGTERM', async () => {
  await queue.shutdown(10000);
  await Promise.all(channels.map(c => c.disconnect()));
  process.exit(0);
});
```

**Key change:** Subsystem startup no longer happens inside `connectWhatsApp`'s `connection.update` handler. The connection handler just sets `isConnected = true` and flushes the outgoing queue. The message loop, IPC watcher, and scheduler start independently and are channel-agnostic.

---

## Step 7: Update `src/task-scheduler.ts`

Minimal change. Replace `sendMessage` in `SchedulerDependencies` with the outbound routing function. Remove the `${deps.assistantName}: ` prefix and `<internal>` stripping — those now happen in `formatOutbound()`.

**Before:**
```typescript
await deps.sendMessage(task.chat_jid, `${deps.assistantName}: ${text}`);
```

**After:**
```typescript
await deps.sendMessage(task.chat_jid, formatOutbound(text));
```

---

## Step 8: Update `processGroupMessages`

This function stays in index.ts (or moves to router.ts). Remove the duplicated `${ASSISTANT_NAME}: ` prefix and `<internal>` stripping. Use `formatOutbound()` and `routeOutbound()` instead.

Also: `setTyping()` currently has a `startsWith('tg:')` branch. Add `setTyping?(jid, isTyping)` as an optional method on the Channel interface. The orchestrator calls `findChannel(channels, jid)?.setTyping?.(jid, isTyping)`. Channels that support it implement it; channels that don't just omit the method. No branching in core code.

---

## File diff summary

```
CREATED:
  src/channels/whatsapp.ts    # ~400 lines (extracted from index.ts)
  src/router.ts               # ~60 lines (outbound routing, formatting)
  src/ipc.ts                  # ~250 lines (extracted from index.ts)

MODIFIED:
  src/index.ts                # 1075 → ~200 lines (orchestrator only)
  src/types.ts                # +Channel interface, +OnInboundMessage
  src/db.ts                   # storeMessage takes NewMessage instead of WAMessage
  src/task-scheduler.ts       # Use formatOutbound, minor

UNCHANGED:
  src/group-queue.ts
  src/container-runner.ts
  src/mount-security.ts
  src/config.ts
  src/logger.ts
```

---

## Execution order

Do it in this order to keep things working at each step:

0. **Write regression tests** — set up vitest, write characterization tests for all logic being moved, run green. This is the safety net for everything that follows.
1. **Add Channel interface to types.ts** — additive, breaks nothing
2. **Create `src/router.ts`** — extract formatting functions, additive
3. **Normalize `storeMessage()`** — change DB interface, update the one call site in index.ts. Run `npm test` — DB round-trip tests must still pass.
4. **Create `src/ipc.ts`** — extract IPC watcher, wire it back in index.ts. Run `npm test` — IPC auth tests must still pass (update imports).
5. **Create `src/channels/whatsapp.ts`** — the big extraction. Move WhatsApp code, replace in index.ts. Run `npm test` — all tests pass (update imports).
6. **Slim index.ts** — decouple subsystem startup from WhatsApp connection handler
7. **Clean up task-scheduler.ts** — use formatOutbound

After each step: update test import paths if functions moved, run `npm test`. All green = safe to continue.

---

## What this enables

When `/add-telegram` runs, it does:

1. Creates `src/channels/telegram.ts` implementing `Channel`
   - `ownsJid(jid)` → `jid.startsWith('tg:')` (JID convention: `tg:{chatId}`)
   - `connect()` → Grammy bot connection + polling
   - `sendMessage()` → Telegram API (with 4096 char splitting)
   - `setTyping()` → `sendChatAction('typing')`
   - `prefixAssistantName` → `false` (Telegram bots show their name natively)
   - `disconnect()` → `bot.stop()`
   - Constructor takes same `onMessage`/`onChatMetadata` callbacks
   - Inbound handler normalizes Grammy messages to `NewMessage`, including trigger translation (Telegram `@bot_username` mentions → `@AssistantName` so `TRIGGER_PATTERN` matches)
   - Non-text messages stored as placeholders (`[Photo]`, `[Voice message]`, etc.)

2. Adds to `index.ts`:
   ```typescript
   import { TelegramChannel } from './channels/telegram.js';
   const telegram = new TelegramChannel({ onMessage, onChatMetadata, registeredGroups });
   const channels: Channel[] = [whatsapp, telegram];
   ```

3. Done. Routing, IPC, scheduling, container execution all work automatically because they go through `routeOutbound()`.

**Agent swarm / bot pool:** This is Telegram-specific custom wiring that lives entirely inside the Telegram channel. The channel can expose additional methods (e.g. `sendPoolMessage(jid, text, sender, groupFolder)`) that the IPC watcher calls when `data.sender` is present. The Channel interface doesn't need to know about pools — this is opt-in functionality accessed by importing the concrete `TelegramChannel` type where needed, not through the generic `Channel` interface.

Same pattern for Gmail, Slack, Discord, SMS — every channel skill follows the same 2-file change.

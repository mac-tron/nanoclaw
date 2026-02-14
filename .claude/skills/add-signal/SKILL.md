---
name: add-signal
description: Add Signal as a messaging channel using signal-cli. Can replace WhatsApp or run alongside it.
---

# Add Signal Channel

Deploy Signal support in NanoClaw using the signal-cli REST API container. This skill creates the Signal channel implementation, configures the sidecar container, links the Signal account, wires everything into the main application, and optionally adds rich features (profile customisation, stickers, group management, IPC handlers for container agents).

For architecture details and security considerations, see [docs/SIGNAL.md](../../../docs/SIGNAL.md).

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). The Signal channel follows the same pattern as WhatsApp and Telegram:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/signal.ts` | `SignalChannel` class |
| `src/signal/client.ts` | WebSocket (receiving) and REST (sending) client |
| `src/signal/daemon.ts` | Spawns local signal-cli daemon (not used with sidecar) |
| `src/config.ts` | Signal configuration exports |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |

The channel implements `connect`, `sendMessage`, `ownsJid`, `disconnect`, and `setTyping`. Inbound messages are delivered via `onMessage` / `onChatMetadata` callbacks, and the existing message loop in `src/index.ts` picks them up automatically.

## Phase 1: Collect Configuration

Gather all required information before starting deployment.

### Step 1: Detect container runtime

```bash
HAS_APPLE=$(command -v container >/dev/null 2>&1 && echo "yes" || echo "no")
HAS_DOCKER=$(command -v docker >/dev/null 2>&1 && echo "yes" || echo "no")
```

- If neither is found, stop and tell the user they need Docker or Apple Container installed first.
- If only one is found, use it automatically and skip the runtime question.

### Step 2: Ask preference questions

Use `AskUserQuestion` with the applicable questions. Include the runtime question only if both runtimes are detected. Batch as many questions as possible into single `AskUserQuestion` calls (up to 4 per call) for a smoother experience.

**First question batch:**

```json
[
  // Only include if BOTH runtimes detected:
  {
    "question": "Which container runtime should run the Signal sidecar?",
    "header": "Runtime",
    "options": [
      {"label": "Apple Container (Recommended)", "description": "Matches NanoClaw's agent containers"},
      {"label": "Docker", "description": "Supports docker-compose and restart policies"}
    ],
    "multiSelect": false
  },
  // Always include these:
  {
    "question": "What level of Signal integration do you need?",
    "header": "Features",
    "options": [
      {"label": "Full features (Recommended)", "description": "Send/receive plus profile, stickers, group management, IPC handlers"},
      {"label": "Basic channel only", "description": "Just send and receive messages"}
    ],
    "multiSelect": false
  },
  {
    "question": "Should Signal replace WhatsApp or run alongside it?",
    "header": "Mode",
    "options": [
      {"label": "Run alongside (Recommended)", "description": "Both Signal and WhatsApp channels active"},
      {"label": "Replace WhatsApp", "description": "Signal becomes the only channel"}
    ],
    "multiSelect": false
  },
  {
    "question": "Who should the bot respond to within registered chats?",
    "header": "Sender filter",
    "options": [
      {"label": "All members (Recommended)", "description": "Anyone in a registered chat can trigger the agent"},
      {"label": "Specific numbers only", "description": "Only approved phone numbers are processed"}
    ],
    "multiSelect": false
  }
]
```

**Second question batch - Main channel setup:**

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use a DM with the bot's number (Note to Self equivalent) or a solo Signal group as your main channel. This ensures only you have admin control.

```json
[
  {
    "question": "Which setup will you use for your main channel?",
    "header": "Main channel",
    "options": [
      {"label": "DM with a specific number (Recommended)", "description": "Your personal number messaging the bot. Only you have admin control."},
      {"label": "Solo Signal group (just me)", "description": "A Signal group with only you in it."},
      {"label": "Group with other people", "description": "Everyone in the group gets admin privileges (security implications)."}
    ],
    "multiSelect": false
  }
]
```

If they choose "Group with other people", ask a follow-up confirmation:

```json
[
  {
    "question": "Are you sure? Everyone in the group will be able to read messages from other chats, schedule tasks, and access mounted directories.",
    "header": "Confirm",
    "options": [
      {"label": "Yes, I understand", "description": "Proceed with a shared admin group"},
      {"label": "No, use a DM instead", "description": "Switch to a private DM as main channel"}
    ],
    "multiSelect": false
  }
]
```

### Step 3: Collect text inputs

Ask for required text values based on Step 2 answers:

**Always ask:**
- Bot's phone number (E.164 format, e.g., `+61412345678`)

**If main channel is "DM with a specific number":**
- The phone number to use as the main channel DM (e.g., the user's personal number). The JID will be `signal:<phoneNumber>`.

**If main channel is a group:**
- Tell the user they'll select the group after Signal is linked (Step 13), since groups can't be queried until the account is connected.

**If "Specific numbers only" was selected:**
- Allowed sender numbers (comma-separated E.164)

**If "Full features" was selected:**
- Bot display name (optional, max 26 characters, e.g., "NanoClaw" or "Jarvis")
- Bot status text (optional, max 140 characters)

### Step 4: Configuration summary

Display a summary table and confirm before deployment:

> **Signal Channel Configuration**
>
> | Setting | Value |
> |---------|-------|
> | Runtime | Apple Container |
> | Features | Full |
> | Phone number | +61412345678 |
> | Display name | Jarvis |
> | Sender filter | All members |
> | Mode | Run alongside WhatsApp |
> | Main channel | DM with +61498765432 |
>
> Proceed with deployment?

Once confirmed, execute all implementation steps without further interaction.

## Phase 2: Implementation

### Step 1: Install WebSocket Dependency

```bash
npm install ws @types/ws
```

### Step 2: Create Signal Client

Create `src/signal/client.ts`. This handles all HTTP and WebSocket communication with the signal-cli REST API.

```typescript
/**
 * Signal-cli JSON-RPC client
 * Communicates with signal-cli daemon over HTTP
 */
import { randomUUID } from 'node:crypto';

export interface SignalRpcResponse<T> {
  jsonrpc?: string;
  result?: T;
  error?: { code?: number; message?: string };
  id?: string | number | null;
}

export interface SignalSseEvent {
  event?: string;
  data?: string;
  id?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('Signal base URL is required');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  return `http://${trimmed}`.replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { baseUrl: string; timeoutMs?: number },
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = randomUUID();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id,
  });

  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/rpc`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (res.status === 201) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    throw new Error(`Signal RPC empty response (status ${res.status})`);
  }

  const parsed = JSON.parse(text) as SignalRpcResponse<T>;
  if (parsed.error) {
    const code = parsed.error.code ?? 'unknown';
    const msg = parsed.error.message ?? 'Signal RPC error';
    throw new Error(`Signal RPC ${code}: ${msg}`);
  }

  return parsed.result as T;
}

/** Mention in a message */
export interface SignalMention {
  start: number;
  length: number;
  author: string;
}

/** Link preview for rich URLs */
export interface SignalLinkPreview {
  url: string;
  title?: string;
  description?: string;
  base64_thumbnail?: string;
}

/** Options for sending a message */
export interface SignalSendOpts {
  baseUrl: string;
  account: string;
  recipients?: string[];
  groupId?: string;
  message: string;
  textMode?: 'normal' | 'styled';
  attachments?: string[];
  quoteTimestamp?: number;
  quoteAuthor?: string;
  quoteMessage?: string;
  mentions?: SignalMention[];
  editTimestamp?: number;
  linkPreview?: SignalLinkPreview;
  viewOnce?: boolean;
  timeoutMs?: number;
}

/**
 * Send a message using the REST v2 API with styled text support.
 * Styling: *italic*, **bold**, ~strikethrough~, `monospace`, ||spoiler||
 */
export async function signalSendV2(opts: SignalSendOpts): Promise<{ timestamp?: number }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {
    number: opts.account,
    message: opts.message,
    text_mode: opts.textMode || 'styled',
  };

  if (opts.groupId) {
    body.recipients = [opts.groupId];
  } else if (opts.recipients) {
    body.recipients = opts.recipients;
  }

  if (opts.attachments && opts.attachments.length > 0) {
    body.base64_attachments = opts.attachments;
  }

  if (opts.quoteTimestamp) {
    body.quote_timestamp = opts.quoteTimestamp;
    if (opts.quoteAuthor) body.quote_author = opts.quoteAuthor;
    if (opts.quoteMessage) body.quote_message = opts.quoteMessage;
  }

  if (opts.mentions && opts.mentions.length > 0) {
    body.mentions = opts.mentions;
  }

  if (opts.editTimestamp) {
    body.edit_timestamp = opts.editTimestamp;
  }

  if (opts.linkPreview) {
    body.link_preview = opts.linkPreview;
  }

  if (opts.viewOnce) {
    body.view_once = true;
  }

  const res = await fetchWithTimeout(
    `${baseUrl}/v2/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal v2 send failed (${res.status}): ${text}`);
  }

  const result = await res.json();
  return result as { timestamp?: number };
}

/**
 * React to a message with an emoji.
 */
export async function signalReact(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  targetAuthor: string;
  targetTimestamp: number;
  reaction: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    target_author: opts.targetAuthor,
    timestamp: opts.targetTimestamp,
    reaction: opts.reaction,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/reactions/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal react failed (${res.status}): ${text}`);
  }
}

/**
 * Remove a reaction from a message.
 */
export async function signalRemoveReaction(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  targetAuthor: string;
  targetTimestamp: number;
  reaction: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    target_author: opts.targetAuthor,
    timestamp: opts.targetTimestamp,
    reaction: opts.reaction,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/reactions/${encodeURIComponent(opts.account)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal remove reaction failed (${res.status}): ${text}`);
  }
}

/**
 * Delete a message for everyone (remote delete).
 */
export async function signalDeleteMessage(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  timestamp: number;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    timestamp: opts.timestamp,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/remote-delete/${encodeURIComponent(opts.account)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal delete message failed (${res.status}): ${text}`);
  }
}

/**
 * Send a read receipt for a message.
 */
export async function signalSendReceipt(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  timestamp: number;
  receiptType?: 'read' | 'viewed';
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    timestamp: opts.timestamp,
    receipt_type: opts.receiptType || 'read',
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/receipts/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal send receipt failed (${res.status}): ${text}`);
  }
}

/** Group information */
export interface SignalGroup {
  id: string;
  name: string;
  description?: string;
  isMember: boolean;
  isBlocked: boolean;
  members: string[];
  admins: string[];
}

/**
 * List all groups the account is a member of.
 */
export async function signalListGroups(opts: {
  baseUrl: string;
  account: string;
  timeoutMs?: number;
}): Promise<SignalGroup[]> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}`,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal list groups failed (${res.status}): ${text}`);
  }

  const groups = await res.json() as Array<{
    id?: string;
    internal_id?: string;
    name?: string;
    description?: string;
    is_member?: boolean;
    is_blocked?: boolean;
    members?: string[];
    admins?: string[];
  }>;

  return groups.map((g) => ({
    id: g.id || g.internal_id || '',
    name: g.name || '',
    description: g.description,
    isMember: g.is_member ?? true,
    isBlocked: g.is_blocked ?? false,
    members: g.members || [],
    admins: g.admins || [],
  }));
}

/**
 * Get detailed information about a specific group.
 */
export async function signalGetGroupInfo(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  timeoutMs?: number;
}): Promise<SignalGroup> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}`,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal get group info failed (${res.status}): ${text}`);
  }

  const g = await res.json() as {
    id?: string;
    internal_id?: string;
    name?: string;
    description?: string;
    is_member?: boolean;
    is_blocked?: boolean;
    members?: string[];
    admins?: string[];
  };

  return {
    id: g.id || g.internal_id || '',
    name: g.name || '',
    description: g.description,
    isMember: g.is_member ?? true,
    isBlocked: g.is_blocked ?? false,
    members: g.members || [],
    admins: g.admins || [],
  };
}

/**
 * Create a poll in a group or DM.
 */
export async function signalCreatePoll(
  opts: {
    baseUrl: string;
    account: string;
    recipient: string;
    question: string;
    answers: string[];
    allowMultipleSelections?: boolean;
    timeoutMs?: number;
  },
): Promise<{ pollTimestamp?: string }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    question: opts.question,
    answers: opts.answers,
    allow_multiple_selections: opts.allowMultipleSelections ?? false,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/polls/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal create poll failed (${res.status}): ${text}`);
  }

  const result = await res.json() as { poll_timestamp?: string };
  return { pollTimestamp: result.poll_timestamp };
}

/**
 * Close an existing poll.
 */
export async function signalClosePoll(
  opts: {
    baseUrl: string;
    account: string;
    recipient: string;
    pollTimestamp: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    poll_timestamp: opts.pollTimestamp,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/polls/${encodeURIComponent(opts.account)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal close poll failed (${res.status}): ${text}`);
  }
}

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(
      `${normalized}/v1/health`,
      { method: 'GET' },
      timeoutMs,
    );
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Stream events from signal-cli via WebSocket.
 * Used with bbernhard/signal-cli-rest-api in json-rpc mode.
 * Calls onEvent for each received message.
 */
export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const { default: WebSocket } = await import('ws');
  const baseUrl = normalizeBaseUrl(params.baseUrl);

  // Convert http:// to ws:// for WebSocket connection
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  const account = params.account ? encodeURIComponent(params.account) : '';
  const url = `${wsUrl}/v1/receive/${account}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const cleanup = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    if (params.abortSignal) {
      params.abortSignal.addEventListener('abort', cleanup);
    }

    ws.on('open', () => {
      // Connection established, messages will arrive via 'message' event
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        // Convert to SSE-like event format for compatibility
        params.onEvent({
          event: 'receive',
          data: JSON.stringify(message),
        });
      } catch (err) {
        // Ignore parse errors
      }
    });

    ws.on('error', (err: Error) => {
      cleanup();
      reject(new Error(`Signal WebSocket error: ${err.message}`));
    });

    ws.on('close', () => {
      if (params.abortSignal) {
        params.abortSignal.removeEventListener('abort', cleanup);
      }
      resolve();
    });
  });
}

// ── Enhanced features (Full features mode) ──────────────────────────

/**
 * Set typing indicator on/off via REST API.
 */
export async function signalSetTyping(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  isTyping: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = { recipient: opts.recipient };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/typing-indicator/${encodeURIComponent(opts.account)}`,
    {
      method: opts.isTyping ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal typing indicator failed (${res.status}): ${text}`);
  }
}

/**
 * Vote on an existing poll.
 */
export async function signalVotePoll(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  pollTimestamp: string;
  votes: number[];
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipient: opts.recipient,
    poll_timestamp: opts.pollTimestamp,
    votes: opts.votes,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/polls/${encodeURIComponent(opts.account)}/vote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal vote poll failed (${res.status}): ${text}`);
  }
}

/** Sticker pack info */
export interface SignalStickerPack {
  packId: string;
  packKey: string;
  title?: string;
  author?: string;
  stickerCount?: number;
}

/**
 * List installed sticker packs.
 */
export async function signalListStickerPacks(opts: {
  baseUrl: string;
  account: string;
  timeoutMs?: number;
}): Promise<SignalStickerPack[]> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/sticker-packs/${encodeURIComponent(opts.account)}`,
    { method: 'GET' },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal list sticker packs failed (${res.status}): ${text}`);
  }

  const packs = await res.json() as Array<{
    pack_id?: string;
    pack_key?: string;
    title?: string;
    author?: string;
    sticker_count?: number;
  }>;

  return packs.map((p) => ({
    packId: p.pack_id || '',
    packKey: p.pack_key || '',
    title: p.title,
    author: p.author,
    stickerCount: p.sticker_count,
  }));
}

/**
 * Send a sticker.
 */
export async function signalSendSticker(opts: {
  baseUrl: string;
  account: string;
  recipient: string;
  packId: string;
  stickerId: number;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = {
    recipients: [opts.recipient],
    sticker: `${opts.packId}:${opts.stickerId}`,
  };

  const res = await fetchWithTimeout(
    `${baseUrl}/v2/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: opts.account, ...body }),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal send sticker failed (${res.status}): ${text}`);
  }
}

/**
 * Create a new Signal group.
 */
export async function signalCreateGroup(opts: {
  baseUrl: string;
  account: string;
  name: string;
  members: string[];
  description?: string;
  timeoutMs?: number;
}): Promise<{ groupId: string }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {
    name: opts.name,
    members: opts.members,
  };
  if (opts.description) body.description = opts.description;

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal create group failed (${res.status}): ${text}`);
  }

  const result = await res.json() as { id?: string };
  return { groupId: result.id || '' };
}

/**
 * Update a Signal group's name, description, or avatar.
 */
export async function signalUpdateGroup(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  name?: string;
  description?: string;
  avatarBase64?: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {};
  if (opts.name) body.name = opts.name;
  if (opts.description) body.description = opts.description;
  if (opts.avatarBase64) body.base64_avatar = opts.avatarBase64;

  if (Object.keys(body).length === 0) return;

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal update group failed (${res.status}): ${text}`);
  }
}

/**
 * Add members to a Signal group.
 */
export async function signalAddGroupMembers(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  members: string[];
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = { members: opts.members };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal add group members failed (${res.status}): ${text}`);
  }
}

/**
 * Remove members from a Signal group.
 */
export async function signalRemoveGroupMembers(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  members: string[];
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body = { members: opts.members };

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}/members`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal remove group members failed (${res.status}): ${text}`);
  }
}

/**
 * Leave a Signal group.
 */
export async function signalQuitGroup(opts: {
  baseUrl: string;
  account: string;
  groupId: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/groups/${encodeURIComponent(opts.account)}/${encodeURIComponent(opts.groupId)}/quit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal quit group failed (${res.status}): ${text}`);
  }
}

/**
 * Update the bot's Signal profile (name, about text, avatar).
 */
export async function signalUpdateProfile(opts: {
  baseUrl: string;
  account: string;
  name?: string;
  about?: string;
  avatarBase64?: string;
  timeoutMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = {};

  if (opts.name) body.name = opts.name;
  if (opts.about) body.about = opts.about;
  if (opts.avatarBase64) body.base64_avatar = opts.avatarBase64;

  if (Object.keys(body).length === 0) {
    return;
  }

  const res = await fetchWithTimeout(
    `${baseUrl}/v1/profiles/${encodeURIComponent(opts.account)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signal update profile failed (${res.status}): ${text}`);
  }
}
```

### Step 3: Create Signal Daemon Manager

Create `src/signal/daemon.ts`. This spawns and manages a local signal-cli process. When using a container sidecar, the daemon is not spawned, but the module is still imported.

```typescript
/**
 * Signal-cli daemon management
 * Spawns and manages the signal-cli HTTP daemon process
 */
import { spawn, ChildProcess } from 'node:child_process';
import { logger } from '../logger.js';

export interface SignalDaemonOpts {
  cliPath: string;
  account?: string;
  httpHost: string;
  httpPort: number;
  sendReadReceipts?: boolean;
}

export interface SignalDaemonHandle {
  pid?: number;
  process: ChildProcess;
  stop: () => void;
}

function classifyLogLine(line: string): 'log' | 'error' | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (/\b(ERROR|WARN|WARNING|FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) {
    return 'error';
  }
  return 'log';
}

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];

  if (opts.account) {
    args.push('-a', opts.account);
  }

  args.push('daemon');
  args.push('--http', `${opts.httpHost}:${opts.httpPort}`);
  args.push('--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  if (opts.sendReadReceipts) {
    args.push('--send-read-receipts');
  }

  return args;
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  const args = buildDaemonArgs(opts);

  logger.info({ cliPath: opts.cliPath, args: args.join(' ') }, 'Spawning signal-cli daemon');

  const child = spawn(opts.cliPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifyLogLine(line);
      if (kind === 'log') {
        logger.debug({ source: 'signal-cli' }, line.trim());
      } else if (kind === 'error') {
        logger.error({ source: 'signal-cli' }, line.trim());
      }
    }
  });

  child.stderr?.on('data', (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifyLogLine(line);
      if (kind === 'log') {
        logger.debug({ source: 'signal-cli' }, line.trim());
      } else if (kind === 'error') {
        logger.error({ source: 'signal-cli' }, line.trim());
      }
    }
  });

  child.on('error', (err) => {
    logger.error({ err }, 'signal-cli spawn error');
  });

  child.on('exit', (code, signal) => {
    logger.info({ code, signal }, 'signal-cli daemon exited');
  });

  return {
    pid: child.pid,
    process: child,
    stop: () => {
      if (!child.killed) {
        logger.info('Stopping signal-cli daemon');
        child.kill('SIGTERM');
      }
    },
  };
}
```

### Step 4: Create Signal Channel

Create `src/channels/signal.ts` implementing the `Channel` interface. Use `src/channels/whatsapp.ts` as a reference for the pattern.

```typescript
/**
 * Signal Channel for NanoClaw
 * Uses signal-cli daemon for Signal messaging
 */
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  signalCheck,
  signalRpcRequest,
  signalSendV2,
  signalCreatePoll,
  signalClosePoll,
  signalReact,
  signalRemoveReaction,
  signalDeleteMessage,
  signalSendReceipt,
  signalListGroups,
  signalGetGroupInfo,
  streamSignalEvents,
  SignalSseEvent,
  SignalMention,
  SignalGroup,
} from '../signal/client.js';
import { spawnSignalDaemon, SignalDaemonHandle } from '../signal/daemon.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

// Signal envelope types from signal-cli
interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  syncMessage?: unknown;
}

interface SignalDataMessage {
  message?: string;
  timestamp?: number;
  groupInfo?: {
    groupId?: string;
    groupName?: string;
  };
  attachments?: Array<{
    id?: string;
    contentType?: string;
    filename?: string;
  }>;
  quote?: {
    text?: string;
  };
  mentions?: Array<{
    start?: number;
    length?: number;
    uuid?: string;
    number?: string;
    name?: string;
  }>;
}

interface SignalReceivePayload {
  envelope?: SignalEnvelope;
  exception?: { message?: string };
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  account: string;
  cliPath?: string;
  httpHost?: string;
  httpPort?: number;
  allowFrom?: string[];
  spawnDaemon?: boolean;
}

export class SignalChannel implements Channel {
  name = 'signal';
  prefixAssistantName = true;

  private opts: SignalChannelOpts;
  private daemon: SignalDaemonHandle | null = null;
  private baseUrl: string;
  private connected = false;
  private abortController: AbortController | null = null;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
    const host = opts.httpHost || '127.0.0.1';
    const port = opts.httpPort || 8080;
    this.baseUrl = `http://${host}:${port}`;
  }

  async connect(): Promise<void> {
    const shouldSpawn = this.opts.spawnDaemon !== false;

    if (shouldSpawn) {
      const cliPath = this.opts.cliPath || 'signal-cli';
      const httpHost = this.opts.httpHost || '127.0.0.1';
      const httpPort = this.opts.httpPort || 8080;

      this.daemon = spawnSignalDaemon({
        cliPath,
        account: this.opts.account,
        httpHost,
        httpPort,
        sendReadReceipts: true,
      });

      logger.info('Spawned signal-cli daemon, waiting for it to be ready...');
    } else {
      logger.info({ baseUrl: this.baseUrl }, 'Connecting to external signal-cli daemon...');
    }

    await this.waitForDaemon(30_000);

    this.connected = true;
    logger.info('Connected to Signal');

    this.startEventLoop();
  }

  private async waitForDaemon(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      const check = await signalCheck(this.baseUrl, 2000);
      if (check.ok) {
        logger.debug('signal-cli daemon is ready');
        return;
      }
      logger.debug({ error: check.error }, 'Waiting for signal-cli daemon...');
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`signal-cli daemon failed to start within ${timeoutMs}ms`);
  }

  private startEventLoop(): void {
    this.abortController = new AbortController();

    const runLoop = async () => {
      while (this.connected && !this.abortController?.signal.aborted) {
        try {
          await streamSignalEvents({
            baseUrl: this.baseUrl,
            account: this.opts.account,
            abortSignal: this.abortController?.signal,
            onEvent: (event) => this.handleEvent(event),
          });
        } catch (err) {
          if (this.abortController?.signal.aborted) {
            break;
          }
          logger.error({ err }, 'Signal SSE stream error, reconnecting in 5s...');
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };

    runLoop().catch((err) => {
      logger.error({ err }, 'Signal event loop failed');
    });
  }

  private handleEvent(event: SignalSseEvent): void {
    if (event.event !== 'receive' || !event.data) return;

    let payload: SignalReceivePayload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      logger.error({ err }, 'Failed to parse Signal event');
      return;
    }

    if (payload.exception?.message) {
      logger.error({ message: payload.exception.message }, 'Signal receive exception');
      return;
    }

    const envelope = payload.envelope;
    if (!envelope) return;
    if (envelope.syncMessage) return;

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    const senderNumber = envelope.sourceNumber || envelope.source;
    if (!senderNumber) return;

    if (this.normalizePhone(senderNumber) === this.normalizePhone(this.opts.account)) return;

    if (this.opts.allowFrom && this.opts.allowFrom.length > 0) {
      const normalized = this.normalizePhone(senderNumber);
      const allowed = this.opts.allowFrom.some(
        (num) => this.normalizePhone(num) === normalized,
      );
      if (!allowed) {
        logger.debug({ sender: senderNumber }, 'Blocked message from non-allowed sender');
        return;
      }
    }

    const groupId = dataMessage.groupInfo?.groupId;
    const groupName = dataMessage.groupInfo?.groupName;
    const isGroup = Boolean(groupId);
    const chatJid = isGroup ? `signal:group:${groupId}` : `signal:${senderNumber}`;

    const timestamp = new Date(
      (envelope.timestamp || dataMessage.timestamp || Date.now()),
    ).toISOString();

    const chatName = isGroup ? (groupName || `Group ${groupId?.slice(0, 8)}`) : (envelope.sourceName || senderNumber);
    this.opts.onChatMetadata(chatJid, timestamp, chatName);

    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) {
      logger.debug({ chatJid }, 'Message from unregistered chat, ignoring');
      return;
    }

    let messageText = dataMessage.message || '';

    // Signal mentions replace the mention text with U+FFFC (Object Replacement Character).
    // Reconstruct the actual text by substituting each mention placeholder with @name.
    // Process mentions in reverse order so string indices stay valid.
    if (dataMessage.mentions && dataMessage.mentions.length > 0) {
      const sorted = [...dataMessage.mentions].sort(
        (a, b) => (b.start ?? 0) - (a.start ?? 0),
      );
      for (const mention of sorted) {
        const start = mention.start ?? 0;
        const length = mention.length ?? 1;
        // If the mention targets the bot's own number, use the assistant name
        // so the trigger pattern (@McClaw) matches correctly.
        const isSelf = mention.number && this.normalizePhone(mention.number) === this.normalizePhone(this.opts.account);
        const name = isSelf ? ASSISTANT_NAME : (mention.name || mention.number || 'unknown');
        messageText =
          messageText.slice(0, start) +
          `@${name}` +
          messageText.slice(start + length);
      }
    }

    messageText = messageText.trim();
    const quoteText = dataMessage.quote?.text?.trim() || '';
    const content = messageText || quoteText;

    if (!content) {
      logger.debug({ chatJid }, 'Empty message, ignoring');
      return;
    }

    const senderName = envelope.sourceName || senderNumber;

    this.opts.onMessage(chatJid, {
      id: String(envelope.timestamp || Date.now()),
      chat_jid: chatJid,
      sender: senderNumber,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/[^\d+]/g, '');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendMessageExtended(jid, text);
  }

  async sendMessageExtended(
    jid: string,
    text: string,
    options?: {
      attachments?: string[];
      quoteTimestamp?: number;
      quoteAuthor?: string;
      quoteMessage?: string;
      mentions?: SignalMention[];
      editTimestamp?: number;
      viewOnce?: boolean;
    },
  ): Promise<{ timestamp?: number }> {
    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected, cannot send message');
      return {};
    }

    try {
      const target = this.jidToTarget(jid);

      const result = await signalSendV2({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipients: target.type === 'dm' ? [target.id] : undefined,
        groupId: target.type === 'group' ? target.id : undefined,
        message: text,
        textMode: 'styled',
        attachments: options?.attachments,
        quoteTimestamp: options?.quoteTimestamp,
        quoteAuthor: options?.quoteAuthor,
        quoteMessage: options?.quoteMessage,
        mentions: options?.mentions,
        editTimestamp: options?.editTimestamp,
        viewOnce: options?.viewOnce,
      });

      logger.info({ jid, length: text.length }, 'Signal message sent');
      return result;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
      throw err;
    }
  }

  async createPoll(jid: string, question: string, answers: string[], allowMultiple = false): Promise<string | undefined> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return undefined; }
    try {
      const target = this.jidToTarget(jid);
      const result = await signalCreatePoll({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, question, answers, allowMultipleSelections: allowMultiple });
      logger.info({ jid, question }, 'Signal poll created');
      return result.pollTimestamp;
    } catch (err) { logger.error({ jid, err }, 'Failed to create Signal poll'); throw err; }
  }

  async closePoll(jid: string, pollTimestamp: string): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalClosePoll({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, pollTimestamp });
      logger.info({ jid, pollTimestamp }, 'Signal poll closed');
    } catch (err) { logger.error({ jid, err }, 'Failed to close Signal poll'); throw err; }
  }

  async react(jid: string, targetAuthor: string, targetTimestamp: number, reaction: string): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalReact({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, targetAuthor, targetTimestamp, reaction });
      logger.info({ jid, reaction }, 'Signal reaction sent');
    } catch (err) { logger.error({ jid, err }, 'Failed to send Signal reaction'); throw err; }
  }

  async removeReaction(jid: string, targetAuthor: string, targetTimestamp: number, reaction: string): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalRemoveReaction({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, targetAuthor, targetTimestamp, reaction });
      logger.info({ jid, reaction }, 'Signal reaction removed');
    } catch (err) { logger.error({ jid, err }, 'Failed to remove Signal reaction'); throw err; }
  }

  async deleteMessage(jid: string, timestamp: number): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalDeleteMessage({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, timestamp });
      logger.info({ jid, timestamp }, 'Signal message deleted');
    } catch (err) { logger.error({ jid, err }, 'Failed to delete Signal message'); throw err; }
  }

  async sendReceipt(jid: string, timestamp: number, type: 'read' | 'viewed' = 'read'): Promise<void> {
    if (!this.connected) return;
    try {
      const target = this.jidToTarget(jid);
      await signalSendReceipt({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, timestamp, receiptType: type });
    } catch (err) { logger.debug({ jid, err }, 'Failed to send Signal receipt'); }
  }

  async listGroups(): Promise<SignalGroup[]> {
    if (!this.connected) return [];
    try {
      return await signalListGroups({ baseUrl: this.baseUrl, account: this.opts.account });
    } catch (err) { logger.error({ err }, 'Failed to list Signal groups'); throw err; }
  }

  async getGroupInfo(groupId: string): Promise<SignalGroup | null> {
    if (!this.connected) return null;
    try {
      return await signalGetGroupInfo({ baseUrl: this.baseUrl, account: this.opts.account, groupId });
    } catch (err) { logger.error({ groupId, err }, 'Failed to get Signal group info'); throw err; }
  }

  private jidToTarget(jid: string): { type: 'group' | 'dm'; id: string } {
    if (jid.startsWith('signal:group:')) {
      // WebSocket events deliver the internal_id (raw base64).
      // The v2 send API requires "group." + base64(internal_id).
      const internalId = jid.replace('signal:group:', '');
      const groupId = `group.${Buffer.from(internalId).toString('base64')}`;
      return { type: 'group', id: groupId };
    }
    if (jid.startsWith('signal:')) return { type: 'dm', id: jid.replace('signal:', '') };
    return { type: 'dm', id: jid };
  }

  isConnected(): boolean { return this.connected; }
  ownsJid(jid: string): boolean { return jid.startsWith('signal:'); }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.abortController?.abort();
    this.daemon?.stop();
    logger.info('Disconnected from Signal');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    try {
      const target = this.jidToTarget(jid);
      const params: Record<string, unknown> = { account: this.opts.account };
      if (target.type === 'group') { params.groupId = target.id; } else { params.recipient = [target.id]; }
      if (!isTyping) { params.stop = true; }
      await signalRpcRequest('sendTyping', params, { baseUrl: this.baseUrl, timeoutMs: 5000 });
    } catch (err) { logger.debug({ jid, err }, 'Failed to send typing indicator'); }
  }
}
```

Key design decisions:
- `prefixAssistantName = true` because Signal linked devices don't display a separate bot identity (unlike Telegram bots)
- `spawnDaemon` defaults to `true` (local daemon mode). Set to `false` when using a container sidecar
- WebSocket connection auto-reconnects after 5 seconds on failure
- `allowFrom` is an optional sender filter applied before message delivery
- JID format: `signal:group:<groupId>` for groups, `signal:<phoneNumber>` for DMs

### Step 5: Update Configuration

Read `src/config.ts` and add Signal config exports near the top with other configuration:

```typescript
// --- Signal configuration ---
export const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || '';
export const SIGNAL_CLI_PATH = process.env.SIGNAL_CLI_PATH || 'signal-cli';
export const SIGNAL_HTTP_HOST = process.env.SIGNAL_HTTP_HOST || '127.0.0.1';
export const SIGNAL_HTTP_PORT = parseInt(process.env.SIGNAL_HTTP_PORT || '8080', 10);
export const SIGNAL_SPAWN_DAEMON = process.env.SIGNAL_SPAWN_DAEMON !== '0';
export const SIGNAL_ALLOW_FROM = process.env.SIGNAL_ALLOW_FROM
  ? process.env.SIGNAL_ALLOW_FROM.split(',').map(s => s.trim())
  : [];
export const SIGNAL_ONLY = process.env.SIGNAL_ONLY === 'true';
```

### Step 6: Update Main Application

Modify `src/index.ts` to support the Signal channel. Read the file first to understand the current structure.

1. **Add imports** at the top:

```typescript
import { SignalChannel } from './channels/signal.js';
import {
  SIGNAL_ACCOUNT,
  SIGNAL_CLI_PATH,
  SIGNAL_HTTP_HOST,
  SIGNAL_HTTP_PORT,
  SIGNAL_SPAWN_DAEMON,
  SIGNAL_ALLOW_FROM,
  SIGNAL_ONLY,
} from './config.js';
```

2. **Ensure a channels array** exists alongside the existing `whatsapp` variable. If Telegram is already set up, this will exist. If not, add it:

```typescript
let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
```

Import `Channel` from `./types.js` if not already imported.

3. **Update `processGroupMessages`** to find the correct channel for the JID instead of using `whatsapp` directly. Replace the direct `whatsapp.setTyping()` and `whatsapp.sendMessage()` calls:

```typescript
const channel = findChannel(channels, chatJid);
if (!channel) return true;

await channel.setTyping?.(chatJid, true);
// ... (existing agent invocation)
await channel.setTyping?.(chatJid, false);
```

In the `onOutput` callback, replace:
```typescript
await whatsapp.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
```
with:
```typescript
const formatted = formatOutbound(channel, text);
if (formatted) await channel.sendMessage(chatJid, formatted);
```

4. **Update `main()` function** to create the Signal channel conditionally:

```typescript
if (!SIGNAL_ONLY) {
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}

if (SIGNAL_ACCOUNT) {
  const signal = new SignalChannel({
    ...channelOpts,
    account: SIGNAL_ACCOUNT,
    cliPath: SIGNAL_CLI_PATH,
    httpHost: SIGNAL_HTTP_HOST,
    httpPort: SIGNAL_HTTP_PORT,
    spawnDaemon: SIGNAL_SPAWN_DAEMON,
    allowFrom: SIGNAL_ALLOW_FROM,
  });
  channels.push(signal);
  await signal.connect();
}

if (channels.length === 0) {
  logger.error('No channels configured. Set SIGNAL_ACCOUNT or disable SIGNAL_ONLY.');
  process.exit(1);
}
```

5. **Update `getAvailableGroups`** to include Signal chats:

```typescript
.filter((c) =>
  c.jid !== '__group_sync__' &&
  (c.jid.endsWith('@g.us') || c.jid.startsWith('tg:') || c.jid.startsWith('signal:')),
)
```

6. **Update shutdown handler** to disconnect all channels:

```typescript
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  await queue.shutdown(10000);
  for (const ch of channels) await ch.disconnect();
  process.exit(0);
};
```

### Step 7: Start Signal Sidecar Container

Pin to a specific version. Signal-cli must stay compatible with Signal's servers.

#### Docker

Check whether `docker-compose.yml` exists first. If it does, add the `signal-cli` service to the existing file rather than overwriting it.

**Important:** The container must NOT be named `nanoclaw-*` because the NanoClaw startup code kills all Docker containers matching that prefix as orphaned agent containers.

```yaml
services:
  signal-cli:
    image: bbernhard/signal-cli-rest-api:0.97
    container_name: signal-cli
    environment:
      - MODE=json-rpc
    volumes:
      - signal-cli-data:/home/.local/share/signal-cli
    ports:
      - "8080:8080"
    restart: unless-stopped

volumes:
  signal-cli-data:
```

```bash
docker compose up -d signal-cli
```

#### Apple Container

```bash
mkdir -p ~/.local/share/signal-cli
chmod 700 ~/.local/share/signal-cli

container pull bbernhard/signal-cli-rest-api:0.97
container run -d \
  --name signal-cli \
  -e MODE=json-rpc \
  -v ~/.local/share/signal-cli:/home/.local/share/signal-cli \
  -p 8080:8080 \
  bbernhard/signal-cli-rest-api:0.97
```

### Step 8: Wait for Container Readiness

```bash
until curl -sf http://localhost:8080/v1/health > /dev/null 2>&1; do
  echo "Waiting for signal-cli to start..."
  sleep 2
done
echo "signal-cli is ready"
```

### Step 9: Link Signal Account

Tell the user:

> Link your Signal account:
> 1. Open **http://localhost:8080/v1/qrcodelink?device_name=nanoclaw** in your browser
> 2. Open Signal on your phone > **Settings** > **Linked Devices** > **Link New Device**
> 3. Scan the QR code
>
> The QR code expires quickly. Refresh if it fails.

Wait for the user to confirm they've linked the account, then verify in container logs:
- Docker: `docker logs signal-cli 2>&1 | tail -20`
- Apple Container: `container logs signal-cli 2>&1 | tail -20`

Look for "Successfully linked" or similar confirmation.

**If linking fails:**
1. Restart the container and generate a fresh QR code
2. Ensure the Signal app is updated to the latest version
3. If the account already has 4 linked devices, the user must unlink one first (Signal Settings > Linked Devices)
4. If repeated failures occur, ask the user to confirm the linking worked before continuing

### Step 10: Update Environment

Add to `.env` (use the phone number collected in Phase 1):

```bash
SIGNAL_ACCOUNT=+61412345678
SIGNAL_HTTP_HOST=127.0.0.1
SIGNAL_HTTP_PORT=8080
SIGNAL_SPAWN_DAEMON=0
```

If "Replace WhatsApp" was selected, also add:

```bash
SIGNAL_ONLY=true
```

If "Specific numbers only" was selected, also add:

```bash
SIGNAL_ALLOW_FROM=+61412345678,+61498765432
```

Sync to container environment:

```bash
cp .env data/env/env
```

### Step 11: Update launchd Environment (macOS)

The launchd plist doesn't read `.env` files. Add these keys to `~/Library/LaunchAgents/com.nanoclaw.plist` inside `EnvironmentVariables`:

```xml
<key>SIGNAL_ACCOUNT</key>
<string>+61412345678</string>
<key>SIGNAL_SPAWN_DAEMON</key>
<string>0</string>
<key>SIGNAL_HTTP_HOST</key>
<string>127.0.0.1</string>
<key>SIGNAL_HTTP_PORT</key>
<string>8080</string>
```

Add `SIGNAL_ONLY` and `SIGNAL_ALLOW_FROM` keys if those variables were configured in Step 10.

### Step 12: Build and Restart

```bash
npm run build
```

Verify build succeeded before continuing. If build fails, fix errors before proceeding.

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Step 13: Register Main Channel

Use the main channel type and phone number collected in Phase 1, Step 2-3.

#### 13a. Get the main channel JID

**For DM** (collected in Phase 1):

The JID is `signal:<phoneNumber>` using the phone number already collected (e.g. `signal:+61412345678`).

**For group** (selected in Phase 1):

Query the signal-cli REST API to list available groups:

```bash
SIGNAL_ACCOUNT=$(grep SIGNAL_ACCOUNT .env | cut -d= -f2)
curl -s "http://localhost:8080/v1/groups/${SIGNAL_ACCOUNT}" | python3 -m json.tool
```

Show the group names and IDs to the user and ask them to pick one. If no groups appear, tell the user to send a message in their Signal group first, then re-query.

#### 13c. Write the registration

Once you have the JID, write to `data/registered_groups.json`. Create the file if it doesn't exist, or merge into it if it does.

```bash
mkdir -p data
```

For DMs (no trigger prefix needed), set `requiresTrigger` to `false`:

```json
{
  "signal:+61412345678": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "requiresTrigger": false
  }
}
```

For groups, keep `requiresTrigger` as `true` (default) unless it's a solo group where the user wants all messages processed:

```json
{
  "signal:group:<groupId>": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "requiresTrigger": false
  }
}
```

Replace `ASSISTANT_NAME` with the configured assistant name (check `src/config.ts` for the current value).

Ensure the groups folder exists:

```bash
mkdir -p groups/main/logs
```

#### 13d. Rebuild and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 14: Test

Tell the user (using the configured assistant name):

> Send a message to your registered Signal chat:
> - **Main channel**: No prefix needed, just send `hello`
> - **Other chats**: `@AssistantName hello`
>
> Check logs: `tail -f logs/nanoclaw.log`

## Phase 3: Enhanced Features (Full features mode only)

**Skip this entire phase if "Basic channel only" was selected in Phase 1.**

### Step 1: Set Initial Profile

If the user provided a display name or status text:

```bash
SIGNAL_ACCOUNT=$(grep SIGNAL_ACCOUNT .env | cut -d= -f2)
curl -X PUT "http://localhost:8080/v1/profiles/${SIGNAL_ACCOUNT}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YOUR_BOT_NAME",
    "about": "YOUR_STATUS_TEXT"
  }'
```

Replace `YOUR_BOT_NAME` and `YOUR_STATUS_TEXT` with the user's values from Phase 1.

### Step 2: Add IPC Handlers

> Signal IPC handlers follow a two-tier security model: messaging enhancements (reactions, polls, stickers) are available to all registered chats, while account-level actions (profile updates, group management) are restricted to the main group only.

Add these cases to the `switch (data.type)` block in `processTaskIpc` in `src/ipc.ts`. First, extend the data type by finding the existing type definition and adding the new fields:

```typescript
// Add these fields to the processTaskIpc data parameter type:
about?: string;
recipient?: string;
targetAuthor?: string;
targetTimestamp?: number;
reaction?: string;
timestamp?: number;
question?: string;
answers?: string[];
allowMultipleSelections?: boolean;
pollTimestamp?: string;
votes?: number[];
isTyping?: boolean;
packId?: string;
stickerId?: number;
groupId?: string;
groupName?: string;
description?: string;
avatarBase64?: string;
members?: string[];
```

Then add the case handlers before the `default:` case:

```typescript
case 'signal_react':
  if (data.recipient && data.targetAuthor && data.targetTimestamp && data.reaction) {
    try {
      const { signalReact } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalReact({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        recipient: data.recipient,
        targetAuthor: data.targetAuthor,
        targetTimestamp: data.targetTimestamp,
        reaction: data.reaction,
      });
      logger.info({ recipient: data.recipient, reaction: data.reaction }, 'Signal reaction sent via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to send Signal reaction via IPC');
    }
  }
  break;

case 'signal_create_poll':
  if (data.recipient && data.question && data.answers) {
    try {
      const { signalCreatePoll } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalCreatePoll({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        recipient: data.recipient,
        question: data.question,
        answers: data.answers,
        allowMultipleSelections: data.allowMultipleSelections ?? false,
      });
      logger.info({ recipient: data.recipient, question: data.question }, 'Signal poll created via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to create Signal poll via IPC');
    }
  }
  break;

case 'update_signal_profile':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized update_signal_profile attempt blocked');
    break;
  }
  if (data.name || data.about) {
    try {
      const { signalUpdateProfile } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalUpdateProfile({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        name: data.name as string | undefined,
        about: data.about as string | undefined,
      });
      logger.info({ name: data.name, about: data.about }, 'Signal profile updated via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to update Signal profile via IPC');
    }
  }
  break;

case 'signal_typing':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized signal_typing attempt blocked');
    break;
  }
  if (data.recipient && typeof data.isTyping === 'boolean') {
    try {
      const { signalSetTyping } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalSetTyping({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        recipient: data.recipient,
        isTyping: data.isTyping,
      });
      logger.info({ recipient: data.recipient, isTyping: data.isTyping }, 'Signal typing indicator set via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to set Signal typing indicator via IPC');
    }
  }
  break;

case 'signal_vote_poll':
  if (data.recipient && data.pollTimestamp && data.votes) {
    try {
      const { signalVotePoll } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalVotePoll({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        recipient: data.recipient,
        pollTimestamp: data.pollTimestamp,
        votes: data.votes,
      });
      logger.info({ recipient: data.recipient, votes: data.votes }, 'Signal poll vote submitted via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to vote on Signal poll via IPC');
    }
  }
  break;

case 'signal_send_sticker':
  if (data.recipient && data.packId && typeof data.stickerId === 'number') {
    try {
      const { signalSendSticker } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalSendSticker({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        recipient: data.recipient,
        packId: data.packId,
        stickerId: data.stickerId,
      });
      logger.info({ recipient: data.recipient, packId: data.packId, stickerId: data.stickerId }, 'Signal sticker sent via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to send Signal sticker via IPC');
    }
  }
  break;

case 'signal_list_sticker_packs':
  try {
    const { signalListStickerPacks } = await import('./signal/client.js');
    const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
    const packs = await signalListStickerPacks({
      baseUrl,
      account: process.env.SIGNAL_ACCOUNT || '',
    });
    const responseFile = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses', `stickers-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(responseFile), { recursive: true });
    fs.writeFileSync(responseFile, JSON.stringify(packs, null, 2));
    logger.info({ count: packs.length, responseFile }, 'Signal sticker packs listed via IPC');
  } catch (err) {
    logger.error({ err }, 'Failed to list Signal sticker packs via IPC');
  }
  break;

case 'signal_create_group':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized signal_create_group attempt blocked');
    break;
  }
  if (data.groupName && data.members) {
    try {
      const { signalCreateGroup } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      const result = await signalCreateGroup({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        name: data.groupName,
        members: data.members,
        description: data.description,
      });
      logger.info({ groupName: data.groupName, groupId: result.groupId }, 'Signal group created via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to create Signal group via IPC');
    }
  }
  break;

case 'signal_update_group':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized signal_update_group attempt blocked');
    break;
  }
  if (data.groupId) {
    try {
      const { signalUpdateGroup } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalUpdateGroup({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        groupId: data.groupId,
        name: data.groupName,
        description: data.description,
        avatarBase64: data.avatarBase64,
      });
      logger.info({ groupId: data.groupId }, 'Signal group updated via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to update Signal group via IPC');
    }
  }
  break;

case 'signal_add_group_members':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized signal_add_group_members attempt blocked');
    break;
  }
  if (data.groupId && data.members) {
    try {
      const { signalAddGroupMembers } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalAddGroupMembers({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        groupId: data.groupId,
        members: data.members,
      });
      logger.info({ groupId: data.groupId, members: data.members }, 'Signal group members added via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to add Signal group members via IPC');
    }
  }
  break;

case 'signal_remove_group_members':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized signal_remove_group_members attempt blocked');
    break;
  }
  if (data.groupId && data.members) {
    try {
      const { signalRemoveGroupMembers } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalRemoveGroupMembers({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        groupId: data.groupId,
        members: data.members,
      });
      logger.info({ groupId: data.groupId, members: data.members }, 'Signal group members removed via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to remove Signal group members via IPC');
    }
  }
  break;

case 'signal_quit_group':
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized signal_quit_group attempt blocked');
    break;
  }
  if (data.groupId) {
    try {
      const { signalQuitGroup } = await import('./signal/client.js');
      const baseUrl = `http://${process.env.SIGNAL_HTTP_HOST || '127.0.0.1'}:${process.env.SIGNAL_HTTP_PORT || '8080'}`;
      await signalQuitGroup({
        baseUrl,
        account: process.env.SIGNAL_ACCOUNT || '',
        groupId: data.groupId,
      });
      logger.info({ groupId: data.groupId }, 'Left Signal group via IPC');
    } catch (err) {
      logger.error({ err }, 'Failed to leave Signal group via IPC');
    }
  }
  break;
```

### Step 3: Add Agent MCP Tools

The container agent needs MCP tools to invoke Signal features via IPC. Add these tools to `container/agent-runner/src/ipc-mcp-stdio.ts` before the stdio transport startup line:

```typescript
// -- Signal messaging tools (all groups) --

server.tool(
  'signal_react',
  'React to a Signal message with an emoji.',
  {
    recipient: z.string().describe('The recipient JID (phone number or group JID)'),
    target_author: z.string().describe('Phone number of the message author'),
    target_timestamp: z.number().describe('Timestamp of the message to react to'),
    reaction: z.string().describe('Emoji reaction (e.g., "👍")'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_react',
      recipient: args.recipient,
      targetAuthor: args.target_author,
      targetTimestamp: args.target_timestamp,
      reaction: args.reaction,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Reaction ${args.reaction} sent.` }] };
  },
);

server.tool(
  'signal_create_poll',
  'Create a poll in a Signal chat.',
  {
    recipient: z.string().describe('The recipient JID'),
    question: z.string().describe('Poll question'),
    answers: z.array(z.string()).describe('Poll answer options'),
    allow_multiple: z.boolean().default(false).describe('Allow selecting multiple answers'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_create_poll',
      recipient: args.recipient,
      question: args.question,
      answers: args.answers,
      allowMultipleSelections: args.allow_multiple,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Poll created: ${args.question}` }] };
  },
);

server.tool(
  'signal_update_profile',
  'Update the bot\'s Signal profile name or status text. Main group only.',
  {
    name: z.string().optional().describe('Display name (max 26 chars)'),
    about: z.string().optional().describe('Status text (max 140 chars)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can update the bot profile.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'update_signal_profile',
      name: args.name,
      about: args.about,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Profile update requested.' }] };
  },
);

server.tool(
  'signal_create_group',
  'Create a new Signal group. Main group only.',
  {
    group_name: z.string().describe('Name for the new group'),
    members: z.array(z.string()).describe('Phone numbers to add (E.164 format)'),
    description: z.string().optional().describe('Group description'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can create Signal groups.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'signal_create_group',
      groupName: args.group_name,
      members: args.members,
      description: args.description,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Group "${args.group_name}" creation requested.` }] };
  },
);

server.tool(
  'signal_list_sticker_packs',
  'List installed Signal sticker packs.',
  {},
  async () => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_list_sticker_packs',
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Sticker pack list requested. Check responses directory.' }] };
  },
);

server.tool(
  'signal_send_sticker',
  'Send a sticker to a Signal chat.',
  {
    recipient: z.string().describe('The recipient JID'),
    pack_id: z.string().describe('Sticker pack ID'),
    sticker_id: z.number().describe('Sticker index within the pack'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_send_sticker',
      recipient: args.recipient,
      packId: args.pack_id,
      stickerId: args.sticker_id,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Sticker sent.' }] };
  },
);
```

### Step 4: Rebuild Container and Restart

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 5: Verify Enhancements

Tell the user:

> Signal enhanced features are now available. The agent can use typing indicators, stickers, group management, and profile updates via IPC.
>
> Check logs: `tail -f logs/nanoclaw.log`

## Troubleshooting

### Container not starting

```bash
# Docker
docker logs signal-cli

# Apple Container
container logs signal-cli
```

Common issues:
- Port 8080 in use: Change `SIGNAL_HTTP_PORT` in `.env`, the launchd plist, and the container port mapping (`-p <new-port>:8080`)
- Volume permissions: Ensure container can write to data directory

### Account not linking

1. Verify container is running: `docker ps | grep signal-cli` or `container list | grep signal-cli`
2. Test QR endpoint: `curl -sf http://localhost:8080/v1/qrcodelink?device_name=nanoclaw -o /dev/null && echo "OK" || echo "FAIL"`
3. Restart container if endpoint fails
4. Ensure Signal app is up to date

### Messages not received

1. Check container logs for "Successfully linked"
2. Verify chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal:%'"`
3. Check `SIGNAL_ALLOW_FROM` if configured
4. Check NanoClaw logs: `tail -f logs/nanoclaw.log`

### Profile update fails

```bash
curl -X PUT "http://localhost:8080/v1/profiles/+YOUR_NUMBER" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test"}'
```

### Sticker packs empty

Sticker packs must be installed on the Signal account first. Install them via the Signal app on your phone.

### IPC handlers not working

1. Check build succeeded: `npm run build`
2. Check NanoClaw restarted: `launchctl list | grep nanoclaw`
3. Check logs for IPC errors: `grep -i "ipc" logs/nanoclaw.log | tail -20`

For additional troubleshooting (WebSocket issues, rate limiting, keeping signal-cli updated), see [docs/SIGNAL.md](../../../docs/SIGNAL.md).

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SIGNAL_ACCOUNT` | Bot's phone number (E.164) | Required |
| `SIGNAL_HTTP_HOST` | Daemon HTTP host | `127.0.0.1` |
| `SIGNAL_HTTP_PORT` | Daemon HTTP port | `8080` |
| `SIGNAL_SPAWN_DAEMON` | `0` for container sidecar | `1` |
| `SIGNAL_CLI_PATH` | Path to signal-cli binary (local mode only) | `signal-cli` |
| `SIGNAL_ALLOW_FROM` | Comma-separated allowed numbers | All |
| `SIGNAL_ONLY` | `true` to disable WhatsApp | `false` |
| `SIGNAL_PROFILE_NAME` | Bot's display name (enhanced only) | None |
| `SIGNAL_PROFILE_ABOUT` | Bot's status text (enhanced only) | None |

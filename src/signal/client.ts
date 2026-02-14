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
  start: number; // Character position where mention starts
  length: number; // Length of the mention text
  author: string; // Phone number or UUID of mentioned user
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
  // Attachments as base64 encoded data
  attachments?: string[];
  // Reply to a specific message
  quoteTimestamp?: number;
  quoteAuthor?: string;
  quoteMessage?: string;
  // Mentions in the message
  mentions?: SignalMention[];
  // Edit an existing message
  editTimestamp?: number;
  // Link preview
  linkPreview?: SignalLinkPreview;
  // View once (disappearing media)
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

  // Attachments
  if (opts.attachments && opts.attachments.length > 0) {
    body.base64_attachments = opts.attachments;
  }

  // Quote/reply
  if (opts.quoteTimestamp) {
    body.quote_timestamp = opts.quoteTimestamp;
    if (opts.quoteAuthor) body.quote_author = opts.quoteAuthor;
    if (opts.quoteMessage) body.quote_message = opts.quoteMessage;
  }

  // Mentions
  if (opts.mentions && opts.mentions.length > 0) {
    body.mentions = opts.mentions;
  }

  // Edit existing message
  if (opts.editTimestamp) {
    body.edit_timestamp = opts.editTimestamp;
  }

  // Link preview
  if (opts.linkPreview) {
    body.link_preview = opts.linkPreview;
  }

  // View once
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
  recipient: string; // Phone number, username, or group ID
  targetAuthor: string; // Author of the message to react to
  targetTimestamp: number; // Timestamp of the message to react to
  reaction: string; // Emoji reaction (e.g., "thumbs up", "red heart")
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
  recipient: string; // Phone number, username, or group ID
  timestamp: number; // Timestamp of the message to delete
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
    recipient: string; // phone number, username, or group ID
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

/**
 * Poll for messages from signal-cli REST API.
 * Used with signal-cli-rest-api Docker container which uses polling instead of SSE.
 */
export async function pollSignalMessages(params: {
  baseUrl: string;
  account: string;
  abortSignal?: AbortSignal;
  onMessage: (envelope: Record<string, unknown>) => void;
  pollIntervalMs?: number;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const pollInterval = params.pollIntervalMs ?? 1000;
  const accountEncoded = encodeURIComponent(params.account);

  while (!params.abortSignal?.aborted) {
    try {
      const res = await fetch(
        `${baseUrl}/v1/receive/${accountEncoded}?timeout=10&send_read_receipts=true`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: params.abortSignal,
        },
      );

      if (!res.ok) {
        throw new Error(`Poll failed (${res.status} ${res.statusText || 'error'})`);
      }

      const messages = await res.json() as Array<{ envelope?: Record<string, unknown>; account?: string }>;

      for (const msg of messages) {
        if (msg.envelope) {
          params.onMessage(msg.envelope);
        }
      }
    } catch (err) {
      if (params.abortSignal?.aborted) {
        break;
      }
      throw err;
    }

    // Small delay between polls
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

/**
 * Signal Channel for NanoClaw
 * Uses signal-cli daemon for Signal messaging
 */
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
}

interface SignalReceivePayload {
  envelope?: SignalEnvelope;
  exception?: { message?: string };
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Signal-specific config
  account: string; // Your Signal phone number (E.164 format: +1234567890)
  cliPath?: string; // Path to signal-cli binary (default: 'signal-cli')
  httpHost?: string; // Daemon HTTP host (default: '127.0.0.1')
  httpPort?: number; // Daemon HTTP port (default: 8080)
  allowFrom?: string[]; // Phone numbers allowed to message (E.164 format)
  spawnDaemon?: boolean; // Spawn signal-cli daemon (default: true). Set false for external daemon (e.g., Docker sidecar)
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

      // Spawn the signal-cli daemon
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

    // Wait for daemon to be ready
    await this.waitForDaemon(30_000);

    this.connected = true;
    logger.info('Connected to Signal');

    // Start listening for events
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
    if (event.event !== 'receive' || !event.data) {
      return;
    }

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

    // Ignore sync messages (our own sent messages echoed back)
    if (envelope.syncMessage) return;

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    // Get sender info
    const senderNumber = envelope.sourceNumber || envelope.source;
    if (!senderNumber) return;

    // Ignore messages from ourselves
    if (this.normalizePhone(senderNumber) === this.normalizePhone(this.opts.account)) {
      return;
    }

    // Check allowFrom if configured
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

    // Determine chat JID (group or DM)
    const groupId = dataMessage.groupInfo?.groupId;
    const groupName = dataMessage.groupInfo?.groupName;
    const isGroup = Boolean(groupId);

    // Create a JID that works with NanoClaw's routing
    // Format: signal:group:<groupId> or signal:<phoneNumber>
    const chatJid = isGroup ? `signal:group:${groupId}` : `signal:${senderNumber}`;

    const timestamp = new Date(
      (envelope.timestamp || dataMessage.timestamp || Date.now()),
    ).toISOString();

    // Notify about chat metadata (for group discovery)
    const chatName = isGroup ? (groupName || `Group ${groupId?.slice(0, 8)}`) : (envelope.sourceName || senderNumber);
    this.opts.onChatMetadata(chatJid, timestamp, chatName);

    // Only deliver full message for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) {
      logger.debug({ chatJid }, 'Message from unregistered chat, ignoring');
      return;
    }

    // Extract message content
    const messageText = dataMessage.message?.trim() || '';
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
    // Remove all non-digit characters except leading +
    return phone.replace(/[^\d+]/g, '');
  }

  /**
   * Send a message. Implements Channel interface.
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendMessageExtended(jid, text);
  }

  /**
   * Send a message with optional attachments, quotes, mentions.
   * Extended method for Signal-specific features.
   */
  async sendMessageExtended(
    jid: string,
    text: string,
    options?: {
      attachments?: string[]; // Base64 encoded attachments
      quoteTimestamp?: number; // Reply to a specific message
      quoteAuthor?: string;
      quoteMessage?: string;
      mentions?: SignalMention[];
      editTimestamp?: number; // Edit an existing message
      viewOnce?: boolean; // Disappearing media
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
        textMode: 'styled', // Enable *italic*, **bold**, ~strike~, `mono`, ||spoiler||
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

  /**
   * Create a poll in the specified chat.
   */
  async createPoll(jid: string, question: string, answers: string[], allowMultiple = false): Promise<string | undefined> {
    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected, cannot create poll');
      return undefined;
    }

    try {
      const target = this.jidToTarget(jid);
      const recipient = target.type === 'group' ? target.id : target.id;

      const result = await signalCreatePoll({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipient,
        question,
        answers,
        allowMultipleSelections: allowMultiple,
      });

      logger.info({ jid, question }, 'Signal poll created');
      return result.pollTimestamp;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to create Signal poll');
      throw err;
    }
  }

  /**
   * Close an existing poll.
   */
  async closePoll(jid: string, pollTimestamp: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected, cannot close poll');
      return;
    }

    try {
      const target = this.jidToTarget(jid);

      await signalClosePoll({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipient: target.id,
        pollTimestamp,
      });

      logger.info({ jid, pollTimestamp }, 'Signal poll closed');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to close Signal poll');
      throw err;
    }
  }

  /**
   * React to a message with an emoji.
   */
  async react(
    jid: string,
    targetAuthor: string,
    targetTimestamp: number,
    reaction: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected, cannot react');
      return;
    }

    try {
      const target = this.jidToTarget(jid);

      await signalReact({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipient: target.id,
        targetAuthor,
        targetTimestamp,
        reaction,
      });

      logger.info({ jid, reaction }, 'Signal reaction sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal reaction');
      throw err;
    }
  }

  /**
   * Remove a reaction from a message.
   */
  async removeReaction(
    jid: string,
    targetAuthor: string,
    targetTimestamp: number,
    reaction: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected, cannot remove reaction');
      return;
    }

    try {
      const target = this.jidToTarget(jid);

      await signalRemoveReaction({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipient: target.id,
        targetAuthor,
        targetTimestamp,
        reaction,
      });

      logger.info({ jid, reaction }, 'Signal reaction removed');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to remove Signal reaction');
      throw err;
    }
  }

  /**
   * Delete a message for everyone.
   */
  async deleteMessage(jid: string, timestamp: number): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected, cannot delete message');
      return;
    }

    try {
      const target = this.jidToTarget(jid);

      await signalDeleteMessage({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipient: target.id,
        timestamp,
      });

      logger.info({ jid, timestamp }, 'Signal message deleted');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to delete Signal message');
      throw err;
    }
  }

  /**
   * Send a read receipt for a message.
   */
  async sendReceipt(jid: string, timestamp: number, type: 'read' | 'viewed' = 'read'): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Signal not connected, cannot send receipt');
      return;
    }

    try {
      const target = this.jidToTarget(jid);

      await signalSendReceipt({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipient: target.id,
        timestamp,
        receiptType: type,
      });

      logger.debug({ jid, timestamp, type }, 'Signal receipt sent');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal receipt');
    }
  }

  /**
   * List all groups the bot is a member of.
   */
  async listGroups(): Promise<SignalGroup[]> {
    if (!this.connected) {
      logger.warn('Signal not connected, cannot list groups');
      return [];
    }

    try {
      const groups = await signalListGroups({
        baseUrl: this.baseUrl,
        account: this.opts.account,
      });

      logger.debug({ count: groups.length }, 'Signal groups listed');
      return groups;
    } catch (err) {
      logger.error({ err }, 'Failed to list Signal groups');
      throw err;
    }
  }

  /**
   * Get detailed information about a specific group.
   */
  async getGroupInfo(groupId: string): Promise<SignalGroup | null> {
    if (!this.connected) {
      logger.warn('Signal not connected, cannot get group info');
      return null;
    }

    try {
      const group = await signalGetGroupInfo({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        groupId,
      });

      logger.debug({ groupId, name: group.name }, 'Signal group info retrieved');
      return group;
    } catch (err) {
      logger.error({ groupId, err }, 'Failed to get Signal group info');
      throw err;
    }
  }

  private jidToTarget(jid: string): { type: 'group' | 'dm'; id: string } {
    if (jid.startsWith('signal:group:')) {
      return { type: 'group', id: jid.replace('signal:group:', '') };
    }
    if (jid.startsWith('signal:')) {
      return { type: 'dm', id: jid.replace('signal:', '') };
    }
    // Assume it's a phone number
    return { type: 'dm', id: jid };
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

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
      const params: Record<string, unknown> = {
        account: this.opts.account,
      };

      if (target.type === 'group') {
        params.groupId = target.id;
      } else {
        params.recipient = [target.id];
      }

      if (!isTyping) {
        params.stop = true;
      }

      await signalRpcRequest('sendTyping', params, {
        baseUrl: this.baseUrl,
        timeoutMs: 5000,
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send typing indicator');
    }
  }
}

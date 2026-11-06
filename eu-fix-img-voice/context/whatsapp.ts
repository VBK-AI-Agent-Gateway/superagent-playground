/**
 * WhatsApp Adapter - Hermes-style WhatsApp platform adapter
 * 
 * Features:
 * - WhatsApp Web protocol via Baileys
 * - QR code authentication
 * - Contact and group management
 * - Media messaging
 */

import { BaseAdapter, type PlatformMessage, type PlatformConfig } from "./base.js";
import { logger } from "../logger.js";
import { readFile, rm } from "node:fs/promises";

const _FILE_MAX_BYTES = 20 * 1024 * 1024; // 单文件上传上限 20MB

export interface WhatsAppConfig extends PlatformConfig {
  platform: "whatsapp";
  label?: string;       // 账号标签：用于 PHONE_<label> 配对码、日志区分
  sessionPath?: string;
  printQr?: boolean;  // Print QR to console
  maxMessageLength?: number;
}

interface WhatsAppContact {
  id: string;
  name?: string;
  isGroup: boolean;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly platform = "whatsapp" as const;
  config: WhatsAppConfig;
  
  private sock: any = null;
  private connected = false;
  private qrCode: string | null = null;
  private pairingCode: string | null = null;
  private codeReqTimer: any = null;
  private reconnectTimer: any = null;
  private reconnectDelay = 5_000;
  private stopping = false;
  private everConnected = false;

  /**
   * 自聊（WhatsApp「给自己发消息」/ Message Yourself）支持。
   *
   * 背景：自聊消息的 key.fromMe 也是 true（发送方就是本机账号），原来那句
   * `if (msg.key.fromMe) continue;` 会把它整个丢掉 —— 这正是「139 号给自己发信息
   * 激活不了 AI 对话」的根因：消息连 bot.ts 都进不去，租户 sid 都不会派生。
   *
   * 但不能简单放行所有 fromMe：本机发出的消息也会被 Baileys 通过 messages.upsert
   * 回灌（多端同步），放行 = AI 把自己上一句回复当成用户输入，无限自我对话。
   *
   * 规则：fromMe 的消息，只有在「remoteJid 是自己 + message id 不在我们已发集合里」
   * 时才算用户输入。其余（我们自己的回声 / 别人转发…）照旧丢弃。
   */
  private ownJids = new Set<string>();

  /**
   * sock.user.id 形如 `8613982292751:2@s.whatsapp.net`（号码:设备号@域名），
   * 而 messages.upsert 的 key.remoteJid 是 `8613982292751@s.whatsapp.net`。
   * 比对前必须把 device 段去掉 —— 注意不能直接 split(":")[0]（会把 @域名 一起切掉）。
   */
  private static stripDevice(raw: unknown): string {
    const id = String(raw ?? "");
    const at = id.indexOf("@");
    if (at <= 0) return "";
    return id.slice(0, at).split(":")[0] + id.slice(at);
  }

  /**
   * 「自己」的全部可能标识 —— **必须同时认 PN 和 LID**。
   *
   * 实测这个部署走的是 LID 迁移：别人的消息 key.remoteJid 是 `xxx@lid`
   * （租户 sid 就是从 `101276150956125@lid` 派生的）。自聊同理，
   * remoteJid 很可能是**自己的 LID** 而不是自己的号码 JID。
   * 之前只比对 sock.user.id（PN 形态）→ 自聊恒不匹配 → 消息被静默丢弃。
   *
   * sock.user 同时提供 id / lid / phoneNumber，三个都收进来。
   */
  private resolveOwnJids(): Set<string> {
    const u = this.sock?.user;
    const live = new Set<string>();
    for (const raw of [u?.id, u?.lid, u?.phoneNumber]) {
      const v = WhatsAppAdapter.stripDevice(raw);
      if (v) live.add(v);
    }
    return live.size ? live : this.ownJids;
  }
  private readonly sentIds = new Set<string>();
  private readonly sentOrder: string[] = [];
  private static readonly SENT_IDS_MAX = 500;

  /** 记下我们发出去的 message id，回灌时用它把「用户自聊」和「我们的回声」分开。 */
  private markSent(id?: string | null): void {
    if (!id) return;
    this.sentIds.add(id);
    this.sentOrder.push(id);
    while (this.sentOrder.length > WhatsAppAdapter.SENT_IDS_MAX) {
      const old = this.sentOrder.shift();
      if (old) this.sentIds.delete(old);
    }
  }

  /** 自聊里、且不在我们已发集合里 = 用户本人在打字。 */
  private isUserSelfChat(msgId?: string | null): boolean {
    return !!msgId && !this.sentIds.has(msgId);
  }

  constructor(config: WhatsAppConfig) {
    super();
    this.config = {
      enabled: true,
      platform: "whatsapp",
      sessionPath: "./whatsapp-session",
      printQr: true,
      maxMessageLength: 4096,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    await this.attach();
  }

  private get sessionDir(): string {
    return this.config.sessionPath || "./whatsapp-session";
  }

  /**
   * 建 socket + 挂事件。可重入：close/515 后由 reconnect 反复调用。
   * 之前这里是 initialize 一次性动作，socket 被 WA 踢掉（429/503/QR refs 耗尽）后
   * 进程照旧活着、只吐最后一张死码 —— /qr 永远不变。
   */
  private async attach(): Promise<void> {
    try {
      const baileys = await import("@whiskeysockets/baileys");

      // 旧 socket 先摘监听再关：否则它迟到的 close 事件会再排一次重连。
      if (this.sock) {
        try { this.sock.ev?.removeAllListeners?.(); } catch { /* noop */ }
        try { this.sock.ws?.close?.(); } catch { /* noop */ }
        this.sock = null;
      }
      this.clearPairingCodeTimer();

      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.sessionDir);

      // WA 版本不匹配 = 噪声握手直接 Connection Terminated（不重试也不出 QR）。
      // 每次启动拉一次最新版本，失败就用库内置默认（离线也能跑）。
      let version: [number, number, number] | undefined;
      try {
        const v = await baileys.fetchLatestBaileysVersion();
        if (v?.version) version = v.version;
      } catch { /* keep default */ }

      this.sock = baileys.makeWASocket({
        auth: state,
        printQRInTerminal: this.config.printQr,
        defaultQueryTimeoutMs: 60 * 1000,
        connectTimeoutMs: 30_000,
        ...(version ? { version } : {}),
      });

      // Handle QR code
      this.sock.ev.on("qr", (qr: string) => {
        this.qrCode = qr;
        logger.info("[WhatsApp] QR Code received - scan with WhatsApp app");
        logger.info(qr);
      });

      // 配对码（8 位手动输码）：扫码被拒时的第二条通道，与 QR 走不同配对协议路径。
      // 必须等 socket open 才能请求（早了 = Connection Closed）；失败重试。
      const phone = process.env[`PHONE_${this.config.label}`];
      if (phone) {
        const reqCode = async () => {
          if (this.pairingCode || this.connected || !this.sock) return;
          try {
            const code = await this.sock.requestPairingCode(phone);
            this.pairingCode = code;
            logger.info(`[WhatsApp] pairing code for ${this.config.label}: ${code}`);
          } catch (e) {
            logger.error("[WhatsApp] requestPairingCode failed:", e);
          }
        };
        this.codeReqTimer = setInterval(reqCode, 5_000);
        this.codeReqTimer.unref?.();
      } else {
        logger.warn(`[WhatsApp] PHONE_${this.config.label} not set, skip pairing code`);
      }

      // 配对握手信号：扫码后这里必须有事件，否则「扫了没反应」
      this.sock.ev.on("pairing-code", (evt: any) =>
        logger.info(`[WhatsApp] pairing-code event: ${JSON.stringify(evt)}`),
      );
      this.sock.ev.on("contacts.upsert", (c: any) =>
        logger.info(`[WhatsApp] contacts.upsert n=${Array.isArray(c) ? c.length : "?"}`),
      );

      // Handle connection update
      this.sock.ev.on("connection.update", (u: any) => {
        const { qr, connection, statusCode, isNewLogin, restartRequired } = u ?? {};
        if (qr) {
          this.qrCode = qr;
        }
        if (connection === "open") {
          this.connected = true;
          this.everConnected = true;
          // 自己的标识（PN + LID，去掉 :device 后缀）—— 自聊判定的基准
          this.ownJids = this.resolveOwnJids();
          this.qrCode = null;
          this.pairingCode = null;
          this.reconnectDelay = 5_000;
          this.clearPairingCodeTimer();
          logger.info("[WhatsApp] Connected!");
        }
        if (connection === "close") {
          this.connected = false;
          logger.info(`[WhatsApp] Disconnected${statusCode ? ` (${statusCode})` : ""}`);
          this.scheduleReconnect(statusCode);
        }
        // 配对成功 / 515：WA 明确要求断开重连才能完成登录（socket.js:736 发 isNewLogin）
        if (isNewLogin || restartRequired) {
          this.connected = false;
          this.scheduleReconnect(undefined, true);
        }
      });

      // Handle credentials update
      this.sock.ev.on("creds.update", saveCreds);

      // Handle messages
      this.sock.ev.on("messages.upsert", ({ messages }: any) => {
        void this.handleMessages(messages); // async: 支持下载图片
      });

      logger.info("[WhatsApp] Initializing...");
    } catch (err) {
      logger.error("[WhatsApp] Failed to initialize:", err);
      throw err;
    }
  }

  private clearPairingCodeTimer(): void {
    if (this.codeReqTimer) {
      clearInterval(this.codeReqTimer);
      this.codeReqTimer = null;
    }
  }

  /** 退避重连。WA 侧 429（注册限流）用更长间隔，别再叠加重试把封期拉长。 */
  private scheduleReconnect(statusCode?: number, immediate = false): void {
    if (this.stopping || this.reconnectTimer) return;
    // 死码必须清掉：/qr 页面继续显示旧配对码 = 用户输一个必然失败的码。
    this.qrCode = null;
    this.pairingCode = null;
    const wait = immediate ? 1_000 : statusCode === 429 ? Math.max(this.reconnectDelay, 30_000) : this.reconnectDelay;
    this.reconnectDelay = immediate ? 5_000 : Math.min(this.reconnectDelay * 2, 60_000);
    logger.info(`[WhatsApp] reconnecting in ${wait}ms${statusCode ? ` (status ${statusCode})` : ""}`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      // 401/403 = 登录态被服务器作废（被踢/换设备），留着 creds 只会永远 401，必须清掉重新出码。
      if (statusCode === 401 || statusCode === 403) await this.resetAuth();
      // ⚠️ 不再按 creds.registered 判「半截」清凭据：探针实测 Baileys 7.0.0-rc14 下该标志位
      // 不可靠（registered=false 也能完整登录 open），按它清 = 每次启动误清好凭据，
      // 手机显示已连、服务端反复重配对死循环（Connected!=0、消息全丢）。真被拒由上面
      // resetAuth（401/403）兑底。
      try {
        await this.attach();
      } catch (e) {
        logger.error("[WhatsApp] reconnect failed:", e);
        this.scheduleReconnect(statusCode);
      }
    }, wait);
    this.reconnectTimer.unref?.();
  }

  private async resetAuth(): Promise<void> {
    await rm(`${this.sessionDir}/creds.json`, { force: true });
    logger.warn("[WhatsApp] auth rejected (401/403) - cleared creds, will request a new QR");
  }

  /**
   * 不再主动清「半截凭据」：实测 Baileys 7.0.0-rc14 下 creds.registered 不可靠
   * （探针证明 registered=false 也能完整登录 open），按它清除 = 每次启动误清好凭据，
   * 手机显示已连、服务端反复重配对死循环（Connected!=0、消息全丢）。
   * 真被拒由 resetAuth（401/403）兑底，见 scheduleReconnect 注释。
   */

  private async handleMessages(messages: any[]): Promise<void> {
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      const own = this.resolveOwnJids();
      const isSelf = !!jid && own.has(jid);
      const echo = !!msg.key.fromMe && isSelf && !this.isUserSelfChat(msg.key.id);
      // 我们自己发的：默认丢弃（防自回声）。唯一例外是「发给自己」且不是我刚发出去的那条
      // —— 即用户在自聊里手打的消息。见 ownJids/sentIds 注释。
      const pass = !msg.key.fromMe || (isSelf && !echo);
      // 每条 inbound 都留痕：之前这里一行日志都没有，「AI 不回复」根本无从查起
      logger.info(
        `[WhatsApp] inbound jid=${jid} fromMe=${!!msg.key.fromMe} self=${isSelf} ` +
          `echo=${echo} known=${[...own].join("|")} -> ${pass ? "PASS" : "DROP"}`,
      );
      if (!pass) continue;
      const isGroup = jid?.endsWith("@g.us");
      
      // 解包 ephemeralMessage/viewOnce 包装 (Baileys extractMessageContent) — 图片常在 ephemeralMessage.message 内
      let unpacked: any = msg.message;
      try {
        const { extractMessageContent } = await import("@whiskeysockets/baileys");
        unpacked = extractMessageContent(msg.message) || msg.message;
      } catch { unpacked = msg.message; }

      // Get message content (多模态: 纯图片 content 空也要放行, 靠 image 字段)
      const content = 
        unpacked?.conversation ||
        unpacked?.extendedTextMessage?.text ||
        unpacked?.imageMessage?.caption ||
        "";

      // 多模态: 下载图片(buffer->base64); 纯图(无caption)也放行
      let imageData: string | undefined;
      let imageMime: string | undefined;
      const im = unpacked?.imageMessage;
      if (im) {
        imageMime = im.mimetype || "image/jpeg";
        try {
          const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
          const buf = await downloadMediaMessage(msg, "buffer", {});
          imageData = Buffer.from(buf).toString("base64");
          logger.info(`[WhatsApp] image downloaded jid=${jid} bytes=${buf.length} mime=${imageMime}`);
          // 诊断: 打印magic字节(FFD8=JPEG 8950=PNG 5249=WEBP) + 存盘真实图
          const magic = Buffer.from(buf.slice(0, 4)).toString("hex");
          console.log(`[MM] image downloaded bytes=${buf.length} mime=${imageMime} magic=${magic}`);
          try { require("fs").writeFileSync("/tmp/lastimg.b64", imageData!); } catch { /* noop */ }
        } catch (e) {
          logger.warn(`[WhatsApp] image download failed jid=${jid}: ${String(e).slice(0, 120)}`);
        }
      }


      // 多模态: 下载视频(buffer->base64); 纯视频(无caption)也放行
      let videoData: string | undefined;
      let videoMime: string | undefined;
      const vm = unpacked?.videoMessage;
      if (vm) {
        videoMime = vm.mimetype || "video/mp4";
        try {
          const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
          const vbuf = await downloadMediaMessage(msg, "buffer", {});
          videoData = Buffer.from(vbuf).toString("base64");
          logger.info(`[WhatsApp] video downloaded jid=${jid} bytes=${vbuf.length} mime=${videoMime}`);
          console.log(`[MM] video downloaded bytes=${vbuf.length} mime=${videoMime}`);
        } catch (e) {
          logger.warn(`[WhatsApp] video download failed jid=${jid}: ${String(e).slice(0, 120)}`);
        }
      }

      // 多模态: 下载文档 (Excel/CSV 等 documentMessage) -> file 字段; 纯文档也放行
      let fileData: string | undefined;
      let fileName: string | undefined;
      let fileMime: string | undefined;
      const dm = unpacked?.documentMessage;
      if (dm) {
        fileMime = dm.mimetype || "application/octet-stream";
        fileName = dm.fileName || dm.title || "upload.bin";
        try {
          const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
          const fbuf = await downloadMediaMessage(msg, "buffer", {});
          if (fbuf.length > 20 * 1024 * 1024) {
            logger.warn(`[WhatsApp] document too large jid=${jid} name=${fileName} bytes=${fbuf.length} > 20 * 1024 * 1024 skip`);
            console.warn(`[MM] document too large name=${fileName} bytes=${fbuf.length} > 20 * 1024 * 1024 skip`);
          } else {
            fileData = Buffer.from(fbuf).toString("base64");
            logger.info(`[WhatsApp] document downloaded jid=${jid} name=${fileName} bytes=${fbuf.length} mime=${fileMime}`);
            console.log(`[MM] document downloaded name=${fileName} bytes=${fbuf.length} mime=${fileMime}`);
          }
        } catch (e) {
          logger.warn(`[WhatsApp] document download failed jid=${jid}: ${String(e).slice(0, 120)}`);
        }
      }
      // 纯图片(无caption无image下载)且无文字 -> 才丢; 有图/有字/有文档都放行
      if (!content && !imageData && !videoData && !fileData) continue;

      const message: PlatformMessage = {
        id: msg.key.id || this.generateMessageId(),
        platform: "whatsapp",
        channelId: jid,
        userId: msg.key.participant || jid,
        content,
        ...(imageData ? { image: { data: imageData, mimeType: imageMime! } } : {}),
        ...(videoData ? { video: { data: videoData, mimeType: videoMime! } } : {}),
        ...(fileData ? { file: { data: fileData, fileName: fileName!, mimeType: fileMime! } } : {}),
        timestamp: msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(),
        metadata: {
          isGroup,
          messageType: msg.message ? Object.keys(msg.message)[0] : "unknown",
          pushName: msg.pushName,
        },
      };

      this.emitMessage(message);
    }
  }

  async start(callbacks: any): Promise<void> {
    await super.start(callbacks);
    
    // Wait for connection
    let attempts = 0;
    while (!this.connected && attempts < 30) {
      await this.sleep(1000);
      attempts++;
    }

    if (!this.connected) {
      logger.warn("[WhatsApp] Not yet connected - waiting for QR scan");
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearPairingCodeTimer();
    if (this.sock) {
      try { await this.sock.logout(); } catch { /* 已断开 */ }
      this.sock = null;
    }
    this.connected = false;
    await super.stop();
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    // D11: 类型校验 —— content 非 string 会让 baileys 内部 extractUrlFromText(text.match) 崩
    const raw = typeof content === "string" ? content : String(content ?? "");
    // Truncate if too long
    const maxLen = this.config.maxMessageLength ?? 4096;
    const text = raw.length > maxLen
      ? raw.slice(0, maxLen - 3) + "..."
      : raw;

    try {
      const result = await this.sock.sendMessage(channelId, { text });
      this.markSent(result?.key?.id);
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      // A3: 异常隔离 —— 发送失败(含 link-preview/baileys 内部崩)不向上抛, 返回空 id 让调用方降级
      logger.error("[WhatsApp] Send error (isolated):", err);
      (globalThis as any).__progressSendFailed = ((globalThis as any).__progressSendFailed || 0) + 1;
      return "";
    }
  }

  async sendImage(channelId: string, imageUrl: string, caption?: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      const result = await this.sock.sendMessage(channelId, {
        image: { url: imageUrl },
        caption,
      });
      this.markSent(result?.key?.id);
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      logger.error("[WhatsApp] Send image error:", err);
      throw err;
    }
  }

  async sendReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      const result = await this.sock.sendMessage(channelId, {
        react: { text: emoji, key: { remoteJid: channelId, id: messageId } },
      });
      this.markSent(result?.key?.id);
    } catch (err) {
      logger.error("[WhatsApp] Reaction error:", err);
    }
  }

  async reply(channelId: string, content: string, messageId: string): Promise<string> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      const result = await this.sock.sendMessage(channelId, {
        text: content,
        contextInfo: {
          stanzaId: messageId,
          remoteJid: channelId,
        },
      });
      this.markSent(result?.key?.id);
      return result?.key?.id || this.generateMessageId();
    } catch (err) {
      // A3: reply 异常隔离, 不让进度/回复失败中断任务
      logger.error("[WhatsApp] Reply error (isolated):", err);
      return "";
    }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.relayMessage(channelId, {
        protocolMessage: {
          type: 6, // MESSAGE_EDIT
          key: { remoteJid: channelId, id: messageId },
          editedMessage: { conversation: [{ text: content }] },
        },
      }, {});
    } catch (err) {
      logger.error("[WhatsApp] Edit error:", err);
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    try {
      await this.sock.sendMessage(channelId, {
        delete: { remoteJid: channelId, id: messageId },
      });
    } catch (err) {
      logger.error("[WhatsApp] Delete error:", err);
    }
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!this.sock || !this.connected) return;

    try {
      await this.sock.sendPresenceUpdate(isTyping ? "composing" : "available", channelId);
    } catch (err) {
      // Ignore presence errors
    }
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return { connected: this.connected };
  }

  async getContacts(): Promise<WhatsAppContact[]> {
    if (!this.sock?.store?.contacts) {
      return [];
    }

    return Object.entries(this.sock.store.contacts).map(([id, contact]: [string, any]) => ({
      id,
      name: contact?.name || contact?.notify || id.split("@")[0],
      isGroup: id.endsWith("@g.us"),
    }));
  }

  async getContact(jid: string): Promise<WhatsAppContact | null> {
    const contacts = await this.getContacts();
    return contacts.find(c => c.id === jid) || null;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  getPairingCode(): string | null {
    return this.pairingCode;
  }
}

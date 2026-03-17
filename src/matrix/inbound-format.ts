const CUSTOM_EMOJI_IMG_RE = /<img\b([^>]*\bdata-mx-emoticon\b[^>]*)>/gi;
const GENERIC_MXC_IMG_RE = /<img\b([^>]*\bsrc\s*=\s*["']mxc:\/\/[^"']+["'][^>]*)>/gi;
const BLOCK_CLOSE_RE = /<\/(?:p|div|li|ul|ol|blockquote|pre|h[1-6]|table|tr)>/gi;
const LINE_BREAK_RE = /<br\s*\/?>/gi;
const LIST_ITEM_OPEN_RE = /<li\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const MXC_URI_RE = /\bmxc:\/\/[^\s<>"')]+/gi;
const MXC_ONLY_TEXT_RE = /^(?:\s*mxc:\/\/[^\s<>"')]+\s*)+$/i;
const BARE_SHORTCODE_RE = /^[A-Za-z0-9_+-]+$/;

export type MatrixAttachmentTextEntry = {
  index: number;
  filename?: string;
  contentType?: string;
  kind?: string;
  savedTo?: string;
  detected?: string;
  cardName?: string;
};

export function resolveMatrixSenderUsername(senderId: string): string | undefined {
  const username = senderId.split(":")[0]?.replace(/^@/, "").trim();
  return username ? username : undefined;
}

export function resolveMatrixInboundSenderLabel(params: {
  senderName: string;
  senderId: string;
  senderUsername?: string;
}): string {
  const senderName = params.senderName.trim();
  const senderUsername = params.senderUsername ?? resolveMatrixSenderUsername(params.senderId);
  if (senderName && senderUsername && senderName !== senderUsername) {
    return `${senderName} (${senderUsername})`;
  }
  return senderName || senderUsername || params.senderId;
}

export function resolveMatrixBodyForAgent(params: {
  isDirectMessage: boolean;
  bodyText: string;
  senderLabel: string;
}): string {
  if (params.isDirectMessage) {
    return params.bodyText;
  }
  return `${params.senderLabel}: ${params.bodyText}`;
}

function quoteMatrixAttachmentValue(value: string): string {
  return value.replace(/["\r\n\t]+/g, " ").trim();
}

function resolveMatrixAttachmentFilename(entry: MatrixAttachmentTextEntry): string {
  const filename = entry.filename?.trim();
  if (filename) {
    return quoteMatrixAttachmentValue(filename);
  }
  const kind = entry.kind?.trim() || "attachment";
  return `${kind}-${entry.index + 1}`;
}

function resolveMatrixAttachmentType(entry: MatrixAttachmentTextEntry): string {
  const contentType = entry.contentType?.trim();
  if (contentType) {
    return quoteMatrixAttachmentValue(contentType);
  }
  const kind = entry.kind?.trim();
  if (!kind) {
    return "application/octet-stream";
  }
  if (kind === "image" || kind === "audio" || kind === "video") {
    return `${kind}/*`;
  }
  return "application/octet-stream";
}

export function buildMatrixAttachmentTextBlocks(params: {
  attachments?: MatrixAttachmentTextEntry[];
  heading?: string;
  itemLabel?: string;
}): string[] {
  const attachments = (params.attachments ?? []).filter(
    (entry) =>
      Boolean(
        entry.filename?.trim() ||
          entry.contentType?.trim() ||
          entry.kind?.trim(),
      ),
  );
  if (attachments.length === 0) {
    return [];
  }
  const heading = params.heading?.trim() || "Attachments";
  const itemLabel = params.itemLabel?.trim() || "Attachment";
  const lines = [`[${heading}: ${attachments.length}]`];
  for (const entry of attachments) {
    const savedTo = entry.savedTo?.trim();
    const detected = entry.detected?.trim();
    const cardName = entry.cardName?.trim();
    lines.push(
      `[${itemLabel} ${entry.index + 1}] filename="${resolveMatrixAttachmentFilename(entry)}" type="${resolveMatrixAttachmentType(entry)}"${
        savedTo ? ` saved to="${quoteMatrixAttachmentValue(savedTo)}"` : ""
      }${detected ? ` detected="${quoteMatrixAttachmentValue(detected)}"` : ""}${
        cardName ? ` card_name="${quoteMatrixAttachmentValue(cardName)}"` : ""
      }`,
    );
  }
  return lines;
}

export function buildMatrixEventContextLine(params: {
  roomId: string;
  eventId: string;
  threadRootId?: string;
}): string {
  const roomId = params.roomId.trim();
  const eventId = params.eventId.trim();
  const threadRootId = params.threadRootId?.trim();
  if (threadRootId) {
    return `[Matrix event] room="${roomId}" event="${eventId}" thread="${threadRootId}"`;
  }
  return `[Matrix event] room="${roomId}" event="${eventId}"`;
}

export function buildMatrixEnrichedBodyText(params: {
  baseBodyText: string;
  attachmentTextBlocks?: string[];
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyAttachmentTextBlocks?: string[];
  replyPreviewTextBlocks?: string[];
  previewTextBlocks: string[];
  eventContextLine?: string;
}): string {
  return [
    params.baseBodyText,
    ...(params.attachmentTextBlocks ?? []),
    ...(params.replyToBody
      ? [
          `[Replying to ${params.replyToSender ?? "Unknown"}${
            params.replyToId ? ` id:${params.replyToId}` : ""
          }]`,
          params.replyToBody,
        ]
      : []),
    ...(params.replyAttachmentTextBlocks ?? []),
    ...((params.replyPreviewTextBlocks ?? []).flatMap((block) => ["[Reply link preview]", block])),
    ...params.previewTextBlocks,
    params.eventContextLine,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function readHtmlAttribute(attrs: string, name: string): string | undefined {
  const quoted = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  if (quoted?.[1]) {
    return decodeHtmlEntities(quoted[1]);
  }
  const singleQuoted = attrs.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  if (singleQuoted?.[1]) {
    return decodeHtmlEntities(singleQuoted[1]);
  }
  return undefined;
}

function describeMatrixMxcUri(raw: string): string {
  return raw.replace(/^mxc:\/\//i, "");
}

function normalizeMatrixEmojiLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/^:[^:\s]+:$/.test(trimmed)) {
    return trimmed;
  }
  if (BARE_SHORTCODE_RE.test(trimmed)) {
    return `:${trimmed}:`;
  }
  return trimmed;
}

function buildCustomEmojiPlaceholder(attrs: string): string {
  const alt = readHtmlAttribute(attrs, "alt")?.trim();
  const title = readHtmlAttribute(attrs, "title")?.trim();
  const src = readHtmlAttribute(attrs, "src")?.trim();
  const preferredText = alt || title;
  if (preferredText && preferredText !== src) {
    return normalizeMatrixEmojiLabel(preferredText);
  }
  if (src?.startsWith("mxc://")) {
    return `[custom emoji ${describeMatrixMxcUri(src)}]`;
  }
  return "[custom emoji]";
}

export function renderMatrixFormattedBody(formattedBody?: string): {
  text: string;
  hasCustomEmoji: boolean;
} {
  if (!formattedBody?.trim()) {
    return { text: "", hasCustomEmoji: false };
  }
  let hasCustomEmoji = false;
  const withCustomEmojiText = formattedBody
    .replace(CUSTOM_EMOJI_IMG_RE, (_match, attrs: string) => {
      hasCustomEmoji = true;
      return ` ${buildCustomEmojiPlaceholder(attrs)} `;
    })
    .replace(GENERIC_MXC_IMG_RE, (_match, attrs: string) => {
      hasCustomEmoji = true;
      return ` ${buildCustomEmojiPlaceholder(attrs)} `;
    });

  const text = decodeHtmlEntities(
    withCustomEmojiText
      .replace(LINE_BREAK_RE, "\n")
      .replace(BLOCK_CLOSE_RE, "\n")
      .replace(LIST_ITEM_OPEN_RE, "- ")
      .replace(TAG_RE, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return { text, hasCustomEmoji };
}

function replaceMatrixMxcUrisWithPlaceholders(text: string, label = "custom emoji"): string {
  return text.replace(MXC_URI_RE, (match) => `[${label} ${describeMatrixMxcUri(match)}]`);
}

export function resolveMatrixReadableBody(params: {
  body?: string;
  formattedBody?: string;
  msgtype?: string;
}): string {
  const body = typeof params.body === "string" ? params.body.trim() : "";
  const formatted = renderMatrixFormattedBody(params.formattedBody);

  let resolvedBody = formatted.hasCustomEmoji || !body ? formatted.text.trim() : body;
  if (!resolvedBody) {
    resolvedBody = body;
  }

  if (resolvedBody && MXC_ONLY_TEXT_RE.test(resolvedBody)) {
    resolvedBody = replaceMatrixMxcUrisWithPlaceholders(resolvedBody);
  }

  const msgtype = params.msgtype?.trim();
  if (msgtype === "m.emote") {
    return resolvedBody ? `/me ${resolvedBody}` : "/me";
  }
  if (msgtype === "m.sticker") {
    return resolvedBody ? `[matrix sticker] ${resolvedBody}` : "[matrix sticker]";
  }
  return resolvedBody;
}

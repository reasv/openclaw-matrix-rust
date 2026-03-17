const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type MatrixDetectedSillyTavernCard = {
  detected: "sillytavern-character-card";
  cardName?: string;
};

export function detectSillyTavernCardFromBuffer(buffer: Buffer): MatrixDetectedSillyTavernCard | undefined {
  if (!isPngBuffer(buffer)) {
    return undefined;
  }

  try {
    const payload = extractCharaPayload(buffer);
    if (!payload) {
      return undefined;
    }
    const parsed = JSON.parse(payload) as unknown;
    const cardName = resolveCardName(parsed);
    if (!cardName) {
      return undefined;
    }
    return {
      detected: "sillytavern-character-card",
      cardName,
    };
  } catch {
    return undefined;
  }
}

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.byteLength > PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function extractCharaPayload(buffer: Buffer): string | undefined {
  let offset = PNG_SIGNATURE.length;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (dataEnd > buffer.length || crcEnd > buffer.length) {
      break;
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "tEXt") {
      const payload = decodeTextChunk(data);
      if (payload) {
        return payload;
      }
    } else if (type === "iTXt") {
      const payload = decodeInternationalTextChunk(data);
      if (payload) {
        return payload;
      }
    }
    if (type === "IEND") {
      break;
    }
    offset = crcEnd;
  }

  return undefined;
}

function decodeTextChunk(data: Buffer): string | undefined {
  const separator = data.indexOf(0);
  if (separator <= 0) {
    return undefined;
  }
  const keyword = data.toString("latin1", 0, separator);
  if (keyword !== "chara") {
    return undefined;
  }
  const encoded = data.toString("latin1", separator + 1).trim();
  if (!encoded) {
    return undefined;
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function decodeInternationalTextChunk(data: Buffer): string | undefined {
  let offset = 0;
  const keywordEnd = data.indexOf(0, offset);
  if (keywordEnd <= 0) {
    return undefined;
  }
  const keyword = data.toString("latin1", offset, keywordEnd);
  if (keyword !== "chara") {
    return undefined;
  }
  offset = keywordEnd + 1;
  if (offset + 2 > data.length) {
    return undefined;
  }
  const compressionFlag = data[offset];
  const compressionMethod = data[offset + 1];
  if (compressionFlag !== 0 || compressionMethod !== 0) {
    return undefined;
  }
  offset += 2;
  const languageEnd = data.indexOf(0, offset);
  if (languageEnd === -1) {
    return undefined;
  }
  offset = languageEnd + 1;
  const translatedKeywordEnd = data.indexOf(0, offset);
  if (translatedKeywordEnd === -1) {
    return undefined;
  }
  offset = translatedKeywordEnd + 1;
  const encoded = data.toString("utf8", offset).trim();
  if (!encoded) {
    return undefined;
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function resolveCardName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const card = value as Record<string, unknown>;
  if (typeof card.name === "string" && card.name.trim()) {
    return card.name.trim();
  }
  const data = card.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const name = (data as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

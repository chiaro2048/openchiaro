import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

export const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_PIXELS = 32_000_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function assertPixels(width, height) {
  if (!width || !height) fail(400, "图片宽高必须大于 0");
  if (width > MAX_PIXELS / height) fail(413, "图片像素超过 3200 万");
}

function inspectPng(data) {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let dimensions;
  let chunkIndex = 0;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) fail(400, "PNG 数据损坏");
    const type = data.toString("ascii", offset + 4, offset + 8);
    const expectedCrc = data.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(data.subarray(offset + 4, offset + 8 + length)) >>> 0;
    if (actualCrc !== expectedCrc) fail(400, "PNG 数据损坏");
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) fail(400, "PNG 缺少有效 IHDR");
      dimensions = { width: data.readUInt32BE(offset + 8), height: data.readUInt32BE(offset + 12) };
    }
    offset = end;
    chunkIndex += 1;
    if (type === "IEND") {
      if (length !== 0 || offset !== data.length) fail(400, "PNG IEND 无效");
      assertPixels(dimensions.width, dimensions.height);
      return { mimeType: "image/png", extension: "png", ...dimensions };
    }
  }
  fail(400, "PNG 数据不完整");
}

function inspectJpeg(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions;
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9) {
      if (!dimensions) fail(400, "JPEG 缺少尺寸信息");
      assertPixels(dimensions.width, dimensions.height);
      return { mimeType: "image/jpeg", extension: "jpg", ...dimensions };
    }
    if (offset + 2 > data.length) fail(400, "JPEG 数据损坏");
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) fail(400, "JPEG 数据损坏");
    if (JPEG_SOF.has(marker)) {
      if (length < 7) fail(400, "JPEG 尺寸段损坏");
      dimensions = {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  fail(400, "JPEG 数据不完整");
}

function decodeAttachment(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["mimeType", "base64"].includes(key))
      || typeof body.mimeType !== "string" || typeof body.base64 !== "string") {
    fail(400, "需要 {mimeType, base64}");
  }
  if (!["image/png", "image/jpeg"].includes(body.mimeType)) {
    fail(415, "只支持 PNG/JPEG 图片");
  }
  if (!body.base64 || body.base64.length > MAX_BASE64_CHARS) {
    fail(413, "附件 base64 超过 24 MiB（原始数据上限 18 MiB）");
  }
  if (body.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) {
    fail(400, "附件不是有效 base64");
  }
  const data = Buffer.from(body.base64, "base64");
  const padding = body.base64.endsWith("==") ? 2 : body.base64.endsWith("=") ? 1 : 0;
  if (data.length !== body.base64.length / 4 * 3 - padding) fail(400, "附件不是有效 base64");
  if (data.length > MAX_IMAGE_BYTES) fail(413, "图片原始数据超过 18 MiB");
  const details = inspectPng(data) || inspectJpeg(data);
  if (!details) fail(415, "附件真实格式不是 PNG/JPEG");
  if (details.mimeType !== body.mimeType) fail(415, "声明 MIME 与图片真实格式不一致");
  return { data, ...details };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function cleanupAttachments(contextDir, now = Date.now()) {
  const attachmentsDir = path.resolve(contextDir, "attachments");
  let realContextDir;
  let realAttachmentsDir;
  try {
    [realContextDir, realAttachmentsDir] = await Promise.all([
      realpath(path.resolve(contextDir)),
      realpath(attachmentsDir),
    ]);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  if (!isInside(realContextDir, realAttachmentsDir)) fail(403, "attachments 目录解析后越界");
  const entries = await readdir(realAttachmentsDir, { withFileTypes: true });
  const cutoff = now - RETENTION_MS;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(realAttachmentsDir, entry.name);
    if ((await lstat(file)).mtimeMs <= cutoff) {
      await unlink(file);
      removed += 1;
    }
  }
  return removed;
}

export async function saveAttachment(contextDir, body) {
  const decoded = decodeAttachment(body);
  await cleanupAttachments(contextDir);
  const attachmentsDir = path.resolve(contextDir, "attachments");
  await mkdir(attachmentsDir, { recursive: true });
  const realContextDir = await realpath(path.resolve(contextDir));
  const realAttachmentsDir = await realpath(attachmentsDir);
  if (!isInside(realContextDir, realAttachmentsDir)) {
    fail(403, "attachments 目录解析后越界");
  }
  const fileName = `chiaro-paste-${Date.now()}-${randomUUID()}.${decoded.extension}`;
  const target = path.resolve(attachmentsDir, fileName);
  if (!isInside(attachmentsDir, target)) fail(403, "附件路径越界");

  let created = false;
  try {
    const handle = await open(target, "wx");
    created = true;
    try {
      await handle.writeFile(decoded.data);
    } finally {
      await handle.close();
    }
    const resolvedTarget = await realpath(target);
    if (!isInside(realAttachmentsDir, resolvedTarget)) fail(403, "附件落盘路径越界");
    return {
      path: resolvedTarget,
      mimeType: decoded.mimeType,
      width: decoded.width,
      height: decoded.height,
      size: decoded.data.length,
    };
  } catch (error) {
    if (created) await unlink(target).catch(() => {});
    throw error;
  }
}

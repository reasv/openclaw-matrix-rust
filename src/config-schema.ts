import {
  AllowFromListSchema,
  buildNestedDmConfigSchema,
  GroupPolicySchema,
} from "openclaw/plugin-sdk/compat";
import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk/matrix";
import { z } from "zod";

const matrixActionsSchema = z
  .object({
    reactions: z.boolean().optional(),
    messages: z.boolean().optional(),
    pins: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    channelInfo: z.boolean().optional(),
  })
  .optional();

const roomSchema = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    threadReplies: z.enum(["off", "inbound", "always"]).optional(),
    tools: ToolPolicySchema,
    autoReply: z.boolean().optional(),
    users: AllowFromListSchema,
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .optional();

const accountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  homeserver: z.string().optional(),
  userId: z.string().optional(),
  accessToken: z.string().optional(),
  password: z.string().optional(),
  recoveryKey: z.string().optional(),
  deviceName: z.string().optional(),
  initialSyncLimit: z.number().int().positive().optional(),
  encryption: z.boolean().optional(),
  allowlistOnly: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional(),
  replyToMode: z.enum(["off", "first", "all"]).optional(),
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  roomHistoryMaxEntries: z.number().int().min(0).optional(),
  mediaMaxMb: z.number().positive().optional(),
  autoDownloadAttachmentMaxBytes: z.number().int().min(-1).optional(),
  autoDownloadAttachmentScope: z.enum(["rooms", "dms", "all"]).optional(),
  xPreviewViaFxTwitter: z.boolean().optional(),
  imageHandlingMode: z.enum(["dual", "multimodal-only", "analysis-only"]).optional(),
  otherMediaPaths: z.boolean().optional(),
  autoJoin: z.enum(["always", "allowlist", "off"]).optional(),
  groupAllowFrom: AllowFromListSchema,
  dm: buildNestedDmConfigSchema(),
  groups: z.object({}).catchall(roomSchema).optional(),
  rooms: z.object({}).catchall(roomSchema).optional(),
  actions: matrixActionsSchema,
});

export const MatrixRustConfigSchema = accountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), accountSchema).optional(),
});

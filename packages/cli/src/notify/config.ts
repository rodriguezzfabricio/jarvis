import { z } from "zod";

/**
 * ~/.jarvis/notify.json, the one notifier config that jarvis setup writes and intake and jarvis run read.
 * The topics are bearer capabilities: nothing here quotes the file's contents, not even in an error.
 */
export const notifyConfigSchema = z.object({
  baseUrl: z.string().url(), topic: z.string().min(1), replyTopic: z.string().min(1),
  since: z.string().optional(), timeoutMs: z.number().int().positive().optional(),
}).strict();
export type NotifyConfig = z.infer<typeof notifyConfigSchema>;

/**
 * The file stage 0 wrote by hand on Oct 23, before jarvis setup existed. It is read as the same config,
 * unchanged on disk, so the topics the phone already subscribes to keep working; jarvis setup keeps it
 * as well, and `--redo ntfy` replaces it with the canonical form and new topics.
 */
const stage0Schema = z.object({ backend: z.literal("ntfy"), server: z.string().url(), topic: z.string().min(1), reply_topic: z.string().min(1) }).strict();

/** The config in its canonical form, from either spelling. Throws a fixed message, never the file's text. */
export function parseNotifyConfig(value: unknown): NotifyConfig {
  const current = notifyConfigSchema.safeParse(value);
  if (current.success) return current.data;
  const stage0 = stage0Schema.safeParse(value);
  if (stage0.success) return { baseUrl: stage0.data.server, topic: stage0.data.topic, replyTopic: stage0.data.reply_topic };
  throw new Error("not a notifier configuration");
}

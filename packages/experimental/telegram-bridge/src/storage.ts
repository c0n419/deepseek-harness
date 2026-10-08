/**
 * Durable bridge state: the Telegram topic and status-card message of each root Session, and
 * the next `getUpdates` offset.
 * @module @deepseek-ai/dsh-experimental-telegram-bridge/storage
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Topic of one root Session. */
export const topicSchema = z.object({
  threadId: z.number().int(),
  cardMessageId: z.number().int(),
}).strict()

/** Topic thread and status-card message of one root Session. */
export type TopicRecord = z.infer<typeof topicSchema>

/** Next update id to request from Telegram. */
export const cursorSchema = z.object({ offset: z.number().int() }).strict()

/** Storage domain owned by the Telegram bridge. */
export const bridgeDomain = defineDomain({
  name: 'telegram_bridge',
  version: 1,
  tables: {
    topics: domainTable<string, TopicRecord>(topicSchema),
    cursor: domainTable<'updates', z.infer<typeof cursorSchema>>(cursorSchema),
  },
})

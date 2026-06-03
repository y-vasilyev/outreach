-- Contact: persist GramJS access_hash off the inline sender entity so we
-- can build an explicit InputPeerUser on cold sync / read-ack even when
-- the session-level entity cache is empty.
ALTER TABLE "contact" ADD COLUMN "tg_access_hash" TEXT;

-- Conversation: timestamp of the operator's most recent read-ack. Used
-- both for the TG read receipt (messages.ReadHistory maxId) and the
-- local "you read at HH:MM" indicator in the inbox.
ALTER TABLE "conversation" ADD COLUMN "last_read_at" TIMESTAMP(3);

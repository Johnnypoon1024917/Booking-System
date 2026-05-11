DROP TABLE IF EXISTS bot_conversations;
DROP TABLE IF EXISTS scim_tokens;
DROP TABLE IF EXISTS graph_subscriptions;
ALTER TABLE users
  DROP COLUMN IF EXISTS external_id,
  DROP COLUMN IF EXISTS email;

DROP TABLE IF EXISTS webhook_subscriptions;
DROP TABLE IF EXISTS floor_plans;
DROP TABLE IF EXISTS weather_events;
DROP TABLE IF EXISTS checkin_tokens;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS customization_config,
  DROP COLUMN IF EXISTS updated_at;

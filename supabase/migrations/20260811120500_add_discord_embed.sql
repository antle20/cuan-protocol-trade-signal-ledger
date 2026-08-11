-- The original Discord embed (title/ticker, order type, prices, notes) was
-- only ever cached in the creating browser's localStorage, never persisted.
-- Any status update performed from a different browser/device/tab (or after
-- that cache was cleared) rebuilt the embed from nothing, so the resulting
-- Discord edit kept only the new status field and dropped the ticker and
-- every other trade detail. Persisting it makes updates work from any session.
alter table trade_histories
  add column if not exists discord_embed jsonb;

comment on column trade_histories.discord_embed is 'Full Discord embed payload (title, fields, etc.) as originally broadcast, kept in sync on every status update so edits from any session preserve the trade details.';

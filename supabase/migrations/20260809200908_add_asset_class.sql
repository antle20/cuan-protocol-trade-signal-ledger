-- Adds asset class classification to trade signals.
alter table trade_histories
  add column if not exists asset_class text
  check (asset_class in ('Crypto', 'Forex', 'Commodities', 'Indices'));

comment on column trade_histories.asset_class is 'Asset class of the traded pair: Crypto, Forex, Commodities, or Indices.';

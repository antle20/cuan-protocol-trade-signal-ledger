import React, { useState, useEffect, useRef } from 'react';
import { supabase, isSupabaseConfigured } from './supabaseClient';

const ASSET_CLASSES = ['Crypto', 'Forex', 'Commodities', 'Indices'];

const CommandCenter = ({ session }) => {
  const [formData, setFormData] = useState({
    pair: '',
    assetClass: ASSET_CLASSES[0],
    orderType: 'Buy Market',
    triggerPrice: '',
    orderPrice: '',
    takeProfit: '',
    stopLoss: '',
    notes: '',
  });
  const [assetClassFilter, setAssetClassFilter] = useState('ALL');

  const [isLoading, setIsLoading] = useState(false);
  const [alert, setAlert] = useState({ show: false, message: '', type: '' });
  const [toast, setToast] = useState({ show: false, message: '', type: '' });
  const [activeTrades, setActiveTrades] = useState([]);
  // Mirrors activeTrades synchronously so async handlers never compute
  // updates off a stale closure (state updates are batched/async).
  const activeTradesRef = useRef([]);
  // Trade ids with an update currently in flight — blocks double-clicks
  // from firing duplicate Discord/Supabase requests for the same trade.
  const [pendingTradeIds, setPendingTradeIds] = useState(() => new Set());

  const markPending = (id) => setPendingTradeIds(prev => new Set(prev).add(id));
  const clearPending = (id) => setPendingTradeIds(prev => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => {
      setToast({ show: false, message: '', type: '' });
    }, 3000);
  };

  const loadFromLocalCache = () => {
    const savedTrades = localStorage.getItem('activeTrades');
    if (!savedTrades) return;
    try {
      const parsedTrades = JSON.parse(savedTrades);
      activeTradesRef.current = parsedTrades;
      setActiveTrades(parsedTrades);
    } catch (e) {
      console.error('Could not parse cached trades', e);
    }
  };

  const loadTrades = async () => {
    if (!isSupabaseConfigured) {
      loadFromLocalCache();
      return;
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // Supabase is the source of truth for *which* trades exist — a trade
    // created on another browser/device has no footprint in this one's
    // localStorage, so we can't rely on that as the starting point.
    const { data, error } = await supabase
      .from('trade_histories')
      .select('id, created_at, triggered_at, settled_at, status, pair_name, asset_class, order_type, order_price, trigger_price, take_profit_price, stop_loss_price, discord_message_id, discord_embed, is_active')
      .or(`is_active.eq.true,created_at.gte.${startOfDay.toISOString()}`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching trades from Supabase:', error);
      loadFromLocalCache();
      return;
    }

    const statusMap = {
      TRIGGERED: 'TRIGGERED',
      TP_HIT: 'TP',
      SL_HIT: 'SL',
      MANUALLY_CLOSED: 'CLOSE',
      ACTIVE: 'ACTIVE',
    };

    // originalEmbed (used to rebuild the Discord embed on status updates)
    // isn't persisted in Supabase, only in this browser's cache — reuse it
    // when we have it so same-browser reloads don't lose the embed's
    // original fields. Trades loaded fresh on another device just won't
    // have one, which handleUpdateTrade already tolerates.
    const localCache = JSON.parse(localStorage.getItem('activeTrades') || '[]');
    const cacheBySupabaseId = new Map(localCache.map(t => [t.supabaseId, t]));

    const trades = data.map(row => {
      const cached = cacheBySupabaseId.get(row.id);
      return {
        id: row.discord_message_id || cached?.id || `local-${row.id}`,
        supabaseId: row.id,
        pair: row.pair_name,
        assetClass: row.asset_class,
        orderType: row.order_type,
        entry: row.order_price ?? row.trigger_price ?? 'Market',
        takeProfit: row.take_profit_price,
        stopLoss: row.stop_loss_price,
        timestamp: row.created_at,
        triggered_at: row.triggered_at,
        settled_at: row.settled_at,
        status: statusMap[row.status] || row.status,
        isClosed: row.is_active === false,
        // Supabase is the source of truth for the embed now; local cache is
        // only a fallback for rows created before discord_embed existed.
        originalEmbed: row.discord_embed ?? cached?.originalEmbed,
      };
    });

    activeTradesRef.current = trades;
    setActiveTrades(trades);
    localStorage.setItem('activeTrades', JSON.stringify(trades));
  };

  useEffect(() => {
    loadTrades();
  }, []);

  const saveTrades = (trades) => {
    activeTradesRef.current = trades;
    setActiveTrades(trades);
    localStorage.setItem('activeTrades', JSON.stringify(trades));
  };

  const orderTypes = [
    'Buy Market',
    'Sell Market',
    'Buy Limit',
    'Sell Limit',
    'Buy Stop',
    'Sell Stop',
    'Buy Stop Limit',
    'Sell Stop Limit',
  ];

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const isBuy = formData.orderType.startsWith('Buy');
  const isMarket = formData.orderType.includes('Market');
  const isLimit = formData.orderType.includes('Limit') && !formData.orderType.includes('Stop Limit');
  const isStopLimit = formData.orderType.includes('Stop Limit');
  const isStop = formData.orderType.includes('Stop') && !isStopLimit;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setAlert({ show: false, message: '', type: '' });

    if (!isSupabaseConfigured) {
      setAlert({ show: true, message: 'Supabase is not configured — check your .env file.', type: 'error' });
      setIsLoading(false);
      return;
    }

    const color = isBuy ? 5763719 : 15548997; // Green for Buy, Red for Sell

    const fields = [
      {
        name: 'Order Type',
        value: formData.orderType,
        inline: true,
      },
    ];

    if ((isStopLimit || isStop) && formData.triggerPrice) {
      fields.push({
        name: 'Trigger Price',
        value: formData.triggerPrice,
        inline: true,
      });
    }

    if ((isLimit || isStopLimit) && formData.orderPrice) {
      fields.push({
        name: 'Order Price',
        value: formData.orderPrice,
        inline: true,
      });
    }

    if (formData.takeProfit) {
      fields.push({
        name: 'Take Profit',
        value: formData.takeProfit,
        inline: true,
      });
    }

    if (formData.stopLoss) {
      fields.push({
        name: 'Stop Loss',
        value: formData.stopLoss,
        inline: true,
      });
    }

    // Market orders fill immediately, so they're already "triggered" on creation
    if (isMarket) {
      fields.push({
        name: 'Update Status',
        value: '🟢 ENTRY TRIGGERED - Trade is Active',
        inline: false,
      });
    }

    const embed = {
      title: `🚨 NEW SETUP: ${formData.pair.toUpperCase()} 🚨`,
      color: color,
      fields: fields,
      timestamp: new Date().toISOString(),
      ...(formData.notes && { description: `**Notes / Analysis**\n${formData.notes}` }),
    };

    // Discord is a notification channel, not the source of truth — its
    // failure must never block recording the trade in Supabase.
    let messageId = `local-${Date.now()}`;
    let discordFailed = false;

    try {
      const { data: fnData, error: fnError } = await supabase.functions.invoke('broadcast-discord', {
        body: { embed, assetClass: formData.assetClass },
      });
      if (fnError) throw fnError;
      if (fnData?.id) messageId = fnData.id;
    } catch (discordError) {
      console.error('Discord broadcast failed:', discordError);
      discordFailed = true;
    }

    try {
      // Determine entry price for display
      let entry = 'Market';
      if (formData.orderPrice) entry = formData.orderPrice;
      else if (formData.triggerPrice) entry = formData.triggerPrice;

      // --- Record trade signal in Supabase ---
      const { data: dbRecord, error: dbError } = await supabase
        .from('trade_histories')
        .insert([
          {
            pair_name: formData.pair.toUpperCase(),
            asset_class: formData.assetClass,
            order_type: formData.orderType,
            order_price: formData.orderPrice ? parseFloat(formData.orderPrice) : null,
            stop_loss_price: formData.stopLoss ? parseFloat(formData.stopLoss) : null,
            take_profit_price: formData.takeProfit ? parseFloat(formData.takeProfit) : null,
            trigger_price: formData.triggerPrice ? parseFloat(formData.triggerPrice) : null,
            notes: formData.notes || null,
            status: isMarket ? 'TRIGGERED' : 'ACTIVE',
            is_active: true,
            discord_message_id: discordFailed ? null : messageId,
            discord_embed: embed,
            ...(isMarket && { triggered_at: new Date().toISOString() }),
          },
        ])
        .select()
        .single();

      if (dbError) {
        console.error('Supabase insert error:', dbError);
        setAlert({ show: true, message: `Supabase error: ${dbError.message}`, type: 'error' });
        setIsLoading(false);
        return;
      }

      // originalEmbed isn't persisted in Supabase, so stash it in the local
      // cache (keyed by supabaseId) before refetching — loadTrades reattaches
      // it to the row that comes back from the database.
      const newTradeForCache = {
        id: messageId,
        supabaseId: dbRecord?.id ?? null,
        pair: formData.pair.toUpperCase(),
        assetClass: formData.assetClass,
        orderType: formData.orderType,
        entry: entry,
        takeProfit: formData.takeProfit || null,
        stopLoss: formData.stopLoss || null,
        timestamp: new Date().toISOString(),
        triggered_at: isMarket ? new Date().toISOString() : null,
        settled_at: null,
        status: isMarket ? 'TRIGGERED' : 'ACTIVE',
        originalEmbed: embed,
      };
      localStorage.setItem('activeTrades', JSON.stringify([newTradeForCache, ...activeTradesRef.current]));

      // The database is the source of truth — re-fetch rather than
      // optimistically appending the trade we just inserted.
      await loadTrades();

      setAlert({
        show: true,
        message: discordFailed
          ? 'Setup saved, but Discord broadcast failed.'
          : 'Setup successfully broadcasted!',
        type: discordFailed ? 'error' : 'success',
      });
      setFormData({
        pair: '',
        assetClass: ASSET_CLASSES[0],
        orderType: 'Buy Market',
        triggerPrice: '',
        orderPrice: '',
        takeProfit: '',
        stopLoss: '',
        notes: '',
      });

      setTimeout(() => {
        setAlert({ show: false, message: '', type: '' });
      }, 3000);
    } catch (error) {
      console.error(error);
      setAlert({ show: true, message: 'Failed to save setup.', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  // Rebuilds a base embed from the trade's own persisted fields for trades
  // that predate discord_embed being saved (or were never cached in this
  // browser) — keeps the ticker/prices visible instead of a status-only post.
  const buildFallbackEmbed = (trade) => {
    const isBuy = trade.orderType?.startsWith('Buy');
    const fields = [{ name: 'Order Type', value: trade.orderType, inline: true }];
    if (trade.entry && trade.entry !== 'Market') {
      fields.push({ name: 'Order Price', value: String(trade.entry), inline: true });
    }
    if (trade.takeProfit) fields.push({ name: 'Take Profit', value: String(trade.takeProfit), inline: true });
    if (trade.stopLoss) fields.push({ name: 'Stop Loss', value: String(trade.stopLoss), inline: true });
    return {
      title: `🚨 NEW SETUP: ${trade.pair} 🚨`,
      color: isBuy ? 5763719 : 15548997,
      fields,
      timestamp: trade.timestamp || new Date().toISOString(),
    };
  };

  const handleUpdateTrade = async (trade, actionType) => {
    let color;
    let statusText;

    switch (actionType) {
      case 'TRIGGERED':
        color = 3447003; // Blue
        statusText = "🟢 ENTRY TRIGGERED - Trade is Active";
        break;
      case 'TP':
        color = 15844367; // Gold
        statusText = "🏆 TAKE PROFIT HIT - Trade Closed";
        break;
      case 'SL':
        color = 15548997; // Red
        statusText = "🛑 STOP LOSS HIT - Trade Closed";
        break;
      case 'CLOSE':
        color = 9807270; // Gray
        statusText = "⚠️ MANUALLY CLOSED - Intervened";
        break;
      default:
        return;
    }

    if (pendingTradeIds.has(trade.id)) return;
    markPending(trade.id);

    try {
      // Missing on trade records from before discord_embed was persisted (or
      // loaded in a session that never cached it) — rebuild one rather than
      // posting a status-only update that drops the ticker and prices.
      const baseEmbed = trade.originalEmbed ?? buildFallbackEmbed(trade);

      // Filter out old update status if it exists
      const filteredFields = (baseEmbed.fields ?? []).filter(f => f.name !== 'Update Status');

      const updatedEmbed = {
        ...baseEmbed,
        color: color,
        fields: [
          ...filteredFields,
          {
            name: 'Update Status',
            value: statusText,
            inline: false,
          }
        ]
      };

      // Discord is a notification channel, not the source of truth — its
      // failure must never block syncing the real status to Supabase.
      let discordFailed = false;

      // Trades with no known Discord message (Discord failed/was skipped at
      // creation, or the trade was loaded on a device that never created it)
      // have no id to PATCH — calling broadcast-discord without a messageId
      // would post a brand-new message instead of editing the original one.
      const hasDiscordMessage = trade.id && !String(trade.id).startsWith('local-');

      // If the original message lived on a webhook that's no longer the one
      // resolved for this trade's asset class (e.g. a per-class webhook secret
      // was added/rotated after the message was posted), broadcast-discord
      // recreates it on the current webhook and hands back the new id — track
      // it here so the Supabase update below keeps discord_message_id in sync.
      let newMessageId = null;

      if (hasDiscordMessage) {
        try {
          const { data: fnData, error: fnError } = await supabase.functions.invoke('broadcast-discord', {
            body: { embed: updatedEmbed, messageId: trade.id, assetClass: trade.assetClass },
          });
          if (fnError) throw fnError;
          if (fnData?.recreated && fnData?.id) {
            newMessageId = fnData.id;
          }
        } catch (discordError) {
          console.error('Discord update failed:', discordError);
          discordFailed = true;
        }
      }

      // --- Sync status to Supabase ---
      if (trade.supabaseId && !supabase) {
        showToast('Supabase is not configured — status change was not saved.', 'error');
        return;
      }

      if (trade.supabaseId) {
        const statusMap = {
          TRIGGERED: 'TRIGGERED',
          TP: 'TP_HIT',
          SL: 'SL_HIT',
          CLOSE: 'MANUALLY_CLOSED',
        };

        const updatePayload = {
          status: statusMap[actionType],
          updated_at: new Date().toISOString(),
          discord_embed: updatedEmbed,
        };

        if (actionType === 'TRIGGERED') {
          updatePayload.triggered_at = new Date().toISOString();
        }

        if (newMessageId) {
          updatePayload.discord_message_id = newMessageId;
        }

        const { error: updateError } = await supabase
          .from('trade_histories')
          .update(updatePayload)
          .eq('id', trade.supabaseId);

        if (updateError) {
          console.error('Supabase update error:', updateError);
          showToast('Failed to update the trade in the database.', 'error');
          return;
        }
      }

      // Update trade with new embed so subsequent updates preserve it
      const updatedTrade = { ...trade, originalEmbed: updatedEmbed, status: actionType };
      if (actionType === 'TRIGGERED') {
        updatedTrade.triggered_at = new Date().toISOString();
      }
      if (newMessageId) {
        updatedTrade.id = newMessageId;
      }
      const newTrades = activeTradesRef.current.map(t => t.id === trade.id ? updatedTrade : t);
      saveTrades(newTrades);

      const cleanStatusText = statusText.replace(/^[^\w]+/, '');
      showToast(
        discordFailed ? `${trade.pair}: ${cleanStatusText} (Discord update failed)` : `${trade.pair}: ${cleanStatusText}`,
        discordFailed ? 'error' : 'success'
      );
    } catch (error) {
      console.error(error);
      showToast('Failed to update the trade.', 'error');
    } finally {
      clearPending(trade.id);
    }
  };

  const handleToggleActive = async (trade) => {
    if (pendingTradeIds.has(trade.id)) return;
    markPending(trade.id);

    try {
      const newIsClosed = !trade.isClosed;

      // Update Supabase
      if (trade.supabaseId && !supabase) {
        showToast('Supabase is not configured — status change was not saved.', 'error');
        return;
      }

      if (trade.supabaseId) {
        const updatePayload = {
          is_active: !newIsClosed,
          updated_at: new Date().toISOString(),
        };

        if (newIsClosed) {
          updatePayload.settled_at = new Date().toISOString();
        } else {
          updatePayload.settled_at = null;
        }

        const { error: updateError } = await supabase
          .from('trade_histories')
          .update(updatePayload)
          .eq('id', trade.supabaseId);

        if (updateError) {
          console.error('Supabase update error:', updateError);
          showToast('Failed to update status in database.', 'error');
          return;
        }
      }

      // Update local state
      const updatedTrade = { ...trade, isClosed: newIsClosed };
      if (newIsClosed) {
        updatedTrade.settled_at = new Date().toISOString();
      } else {
        updatedTrade.settled_at = null;
      }
      const newTrades = activeTradesRef.current.map(t => t.id === trade.id ? updatedTrade : t);
      saveTrades(newTrades);

      showToast(`${trade.pair} marked ${newIsClosed ? 'Settled' : 'Active'}.`, 'success');
    } finally {
      clearPending(trade.id);
    }
  };

  const filteredTrades = assetClassFilter === 'ALL'
    ? activeTrades
    : activeTrades.filter((trade) => trade.assetClass === assetClassFilter);

  return (
    <div className="min-h-screen bg-[#0d0f12] text-gray-200 p-4 font-sans flex justify-center items-start pt-10">
      {toast.show && (
        <div
          className={`fixed top-6 right-6 z-50 max-w-sm p-4 rounded-md text-sm border shadow-2xl ${toast.type === 'success'
            ? 'bg-green-900/90 border-green-500/50 text-green-200'
            : 'bg-red-900/90 border-red-500/50 text-red-200'
            }`}
        >
          {toast.message}
        </div>
      )}
      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* Main Form Panel */}
        <div className="lg:col-span-5 bg-[#14161a] border border-[#23262e] rounded-lg shadow-2xl p-6 sm:p-8 self-start">
          <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#23262e]">
            <div>
              <h1 className="text-xl font-bold tracking-wider text-white">COMMAND CENTER</h1>
              <p className="text-xs text-gray-500 mt-1 uppercase tracking-widest">Signal Blaster</p>
            </div>
            <div className="flex items-center gap-3">
              {session?.user?.email && (
                <span className="text-[11px] text-gray-500 font-mono hidden sm:inline">{session.user.email}</span>
              )}
              <button
                onClick={handleLogout}
                className="text-[10px] px-2 py-1 rounded font-bold tracking-wider uppercase bg-[#1c1e24] text-gray-400 hover:bg-[#23262e] hover:text-gray-200 border border-[#23262e] transition-colors"
              >
                Sign Out
              </button>
              <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></div>
            </div>
          </div>

          {!isSupabaseConfigured && (
            <div className="mb-6 p-4 rounded-md text-sm border bg-red-900/20 border-red-500/50 text-red-400">
              Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.
            </div>
          )}

          {alert.show && (
            <div
              className={`mb-6 p-4 rounded-md text-sm border ${alert.type === 'success'
                ? 'bg-green-900/20 border-green-500/50 text-green-400'
                : 'bg-red-900/20 border-red-500/50 text-red-400'
                }`}
            >
              {alert.message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Pair/Asset & Asset Class Row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                  Asset Pair
                </label>
                <input
                  type="text"
                  name="pair"
                  value={formData.pair}
                  onChange={handleChange}
                  placeholder="BTCUSDT"
                  required
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white focus:outline-none focus:border-[#f3a910] transition-colors uppercase placeholder-gray-700 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                  Asset Class
                </label>
                <div className="relative">
                  <select
                    name="assetClass"
                    value={formData.assetClass}
                    onChange={handleChange}
                    className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white appearance-none focus:outline-none focus:border-[#f3a910] transition-colors"
                  >
                    {ASSET_CLASSES.map((assetClass) => (
                      <option key={assetClass} value={assetClass}>
                        {assetClass}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-500">
                    <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                      <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>

            {/* Order Type Row */}
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                Order Type
              </label>
              <div className="relative">
                <select
                  name="orderType"
                  value={formData.orderType}
                  onChange={handleChange}
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white appearance-none focus:outline-none focus:border-[#f3a910] transition-colors"
                >
                  {orderTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-500">
                  <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                    <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Dynamic Price Inputs */}
            {!isMarket && (
              <div className="bg-[#101216] border border-[#1c1e24] rounded-md p-4 space-y-4">
                <div className={`grid ${isStopLimit ? 'grid-cols-2' : 'grid-cols-1'} gap-4`}>
                  {(isStopLimit || isStop) && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                        Trigger Price
                      </label>
                      <input
                        type="number"
                        step="any"
                        name="triggerPrice"
                        value={formData.triggerPrice}
                        onChange={handleChange}
                        placeholder="0.00"
                        required={isStopLimit || isStop}
                        className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white focus:outline-none focus:border-[#f3a910] transition-colors font-mono placeholder-gray-700"
                      />
                    </div>
                  )}
                  {(isLimit || isStopLimit) && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                        Order Price
                      </label>
                      <input
                        type="number"
                        step="any"
                        name="orderPrice"
                        value={formData.orderPrice}
                        onChange={handleChange}
                        placeholder="0.00"
                        required={isLimit || isStopLimit}
                        className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white focus:outline-none focus:border-[#f3a910] transition-colors font-mono placeholder-gray-700"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TP & SL Row */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                  Take Profit
                </label>
                <input
                  type="number"
                  step="any"
                  name="takeProfit"
                  value={formData.takeProfit}
                  onChange={handleChange}
                  placeholder="0.00"
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-green-400 focus:outline-none focus:border-green-500 transition-colors font-mono placeholder-gray-700"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                  Stop Loss
                </label>
                <input
                  type="number"
                  step="any"
                  name="stopLoss"
                  value={formData.stopLoss}
                  onChange={handleChange}
                  placeholder="0.00"
                  className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-red-400 focus:outline-none focus:border-red-500 transition-colors font-mono placeholder-gray-700"
                />
              </div>
            </div>

            {/* Notes / Analysis */}
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                Notes / Analysis
              </label>
              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                placeholder="e.g. Broken resistance, targeting next supply zone..."
                rows="3"
                className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white focus:outline-none focus:border-[#f3a910] transition-colors resize-none placeholder-gray-700"
              ></textarea>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className={`w-full py-4 rounded font-bold uppercase tracking-wider text-sm transition-all duration-200 mt-6 shadow-lg ${isBuy
                ? 'bg-[#10b981] hover:bg-[#059669] text-white shadow-green-900/20'
                : 'bg-[#ef4444] hover:bg-[#dc2626] text-white shadow-red-900/20'
                } ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`}
            >
              {isLoading ? 'Broadcasting...' : 'Blast to Discord'}
            </button>
          </form>
        </div>

        {/* Active Trades Panel */}
        <div className="lg:col-span-7 bg-[#14161a] border border-[#23262e] rounded-lg shadow-2xl p-6 sm:p-8 self-start overflow-hidden">
          <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#23262e]">
            <h2 className="text-xl font-bold tracking-wider text-white uppercase">Today's Trades</h2>
            <span className="text-xs bg-[#23262e] px-3 py-1 rounded-full font-mono text-gray-300">
              {filteredTrades.length} Total
            </span>
          </div>

          {/* Asset Class Filter Navbar */}
          <nav className="flex flex-wrap gap-2 mb-6">
            {['ALL', ...ASSET_CLASSES].map((assetClass) => (
              <button
                key={assetClass}
                type="button"
                onClick={() => setAssetClassFilter(assetClass)}
                className={`text-xs font-bold px-3 py-1.5 rounded-full uppercase tracking-wide border transition-colors ${assetClassFilter === assetClass
                  ? 'bg-[#f3a910] text-black border-[#f3a910]'
                  : 'bg-[#0d0f12] text-gray-400 border-[#23262e] hover:border-[#f3a910]/50 hover:text-gray-200'
                  }`}
              >
                {assetClass === 'ALL' ? 'All' : assetClass}
              </button>
            ))}
          </nav>

          {filteredTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              <svg className="w-12 h-12 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-sm">
                {activeTrades.length === 0 ? 'No trades added today.' : 'No trades for this asset class today.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4 max-h-[700px] overflow-y-auto pr-2 custom-scrollbar">
              {filteredTrades.map((trade) => {
                const isPending = pendingTradeIds.has(trade.id);
                return (
                  <div key={trade.id} className="bg-[#0d0f12] border border-[#1c1e24] rounded-md p-4 flex flex-col gap-4">

                    {/* Trade Info Header */}
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className={`text-xs font-bold px-2 py-0.5 rounded ${trade.orderType.startsWith('Buy') ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                            {trade.orderType}
                          </span>
                          <span className="font-mono font-bold text-white tracking-wider">{trade.pair}</span>
                          {trade.assetClass && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide border bg-[#1c1e24] text-gray-400 border-[#2a2d36]">
                              {trade.assetClass}
                            </span>
                          )}
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide border ${
                            trade.status === 'TP' ? 'bg-yellow-900/20 text-yellow-400 border-yellow-500/30' :
                            trade.status === 'SL' ? 'bg-red-900/20 text-red-400 border-red-500/30' :
                            trade.status === 'TRIGGERED' ? 'bg-blue-900/20 text-blue-400 border-blue-500/30' :
                            trade.status === 'CLOSE' ? 'bg-gray-800 text-gray-400 border-gray-600' :
                            'bg-[#1c1e24] text-gray-500 border-[#2a2d36]' // ACTIVE
                          }`}>
                            {trade.status === 'CLOSE' ? 'MANUAL CLOSE' : trade.status}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 font-mono flex flex-col gap-1 mt-2">
                          <div>
                            <span className="text-gray-400">Entry:</span> {trade.entry}
                            {trade.takeProfit && <span> &bull; <span className="text-green-500/70">TP:</span> {trade.takeProfit}</span>}
                            {trade.stopLoss && <span> &bull; <span className="text-red-500/70">SL:</span> {trade.stopLoss}</span>}
                          </div>
                          <div className="text-[10px] grid grid-cols-1 gap-0.5 mt-0.5">
                            <div><span className="text-gray-600">Created:</span> {new Date(trade.timestamp).toLocaleString('en-GB')}</div>
                            {trade.triggered_at && <div><span className="text-gray-600">Triggered:</span> {new Date(trade.triggered_at).toLocaleString('en-GB')}</div>}
                            {trade.settled_at && <div><span className="text-gray-600">Settled:</span> {new Date(trade.settled_at).toLocaleString('en-GB')}</div>}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleToggleActive(trade)}
                        disabled={isPending}
                        className={`text-[10px] px-2 py-1 rounded font-bold tracking-wider transition-colors uppercase ${isPending ? 'opacity-40 cursor-not-allowed' : ''
                          } ${trade.isClosed
                            ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 border border-gray-600'
                            : 'bg-green-900/30 text-green-400 hover:bg-green-900/50 border border-green-500/30'
                          }`}
                      >
                        {trade.isClosed ? 'Settled' : 'Active'}
                      </button>
                    </div>

                    {/* Action Buttons */}
                    {trade.isClosed ? (
                      <div className="bg-[#1c1e24] border border-[#23262e] rounded p-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Trade Settled
                      </div>
                    ) : (
                      <div className={`grid gap-2 ${trade.status !== 'ACTIVE' ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1'}`}>
                        <button
                          onClick={() => handleUpdateTrade(trade, 'TRIGGERED')}
                          disabled={trade.status !== 'ACTIVE' || isPending}
                          className={`bg-blue-900/20 border border-blue-500/30 text-blue-400 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide ${trade.status !== 'ACTIVE' || isPending ? 'opacity-30 cursor-not-allowed' : 'hover:bg-blue-900/40'
                            }`}
                        >
                          Triggered
                        </button>
                        {trade.status !== 'ACTIVE' && (
                          <>
                            <button
                              onClick={() => handleUpdateTrade(trade, 'TP')}
                              disabled={isPending}
                              className={`bg-yellow-900/20 border border-yellow-500/30 text-yellow-400 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide ${isPending ? 'opacity-30 cursor-not-allowed' : 'hover:bg-yellow-900/40'
                                }`}
                            >
                              TP Hit
                            </button>
                            <button
                              onClick={() => handleUpdateTrade(trade, 'SL')}
                              disabled={isPending}
                              className={`bg-red-900/20 border border-red-500/30 text-red-400 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide ${isPending ? 'opacity-30 cursor-not-allowed' : 'hover:bg-red-900/40'
                                }`}
                            >
                              SL Hit
                            </button>
                            <button
                              onClick={() => handleUpdateTrade(trade, 'CLOSE')}
                              disabled={isPending}
                              className={`bg-gray-800 border border-gray-600 text-gray-300 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide ${isPending ? 'opacity-30 cursor-not-allowed' : 'hover:bg-gray-700'
                                }`}
                            >
                              Close Manual
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandCenter;

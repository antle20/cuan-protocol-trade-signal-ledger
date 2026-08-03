import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

const CommandCenter = () => {
  const [formData, setFormData] = useState({
    pair: '',
    orderType: 'Buy Market',
    triggerPrice: '',
    orderPrice: '',
    takeProfit: '',
    stopLoss: '',
    notes: '',
  });

  const [isLoading, setIsLoading] = useState(false);
  const [alert, setAlert] = useState({ show: false, message: '', type: '' });
  const [activeTrades, setActiveTrades] = useState([]);

  useEffect(() => {
    const savedTrades = localStorage.getItem('activeTrades');
    if (savedTrades) {
      try {
        const parsedTrades = JSON.parse(savedTrades);
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const todaysTrades = parsedTrades.filter(trade => {
          const tradeDate = new Date(trade.timestamp);
          return tradeDate >= startOfDay;
        });

        setActiveTrades(todaysTrades);

        if (todaysTrades.length !== parsedTrades.length) {
          localStorage.setItem('activeTrades', JSON.stringify(todaysTrades));
        }
      } catch (e) {
        console.error("Could not parse saved trades", e);
      }
    }
  }, []);

  const saveTrades = (trades) => {
    setActiveTrades(trades);
    localStorage.setItem('activeTrades', JSON.stringify(trades));
  };

  const orderTypes = [
    'Buy Market',
    'Sell Market',
    'Buy Limit',
    'Sell Limit',
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setAlert({ show: false, message: '', type: '' });

    let webhookUrl = import.meta.env.VITE_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      setAlert({ show: true, message: 'Webhook URL is missing in .env!', type: 'error' });
      setIsLoading(false);
      return;
    }

    // Append wait=true to capture the message id
    const postUrl = new URL(webhookUrl);
    postUrl.searchParams.append('wait', 'true');

    const color = isBuy ? 5763719 : 15548997; // Green for Buy, Red for Sell

    const fields = [
      {
        name: 'Order Type',
        value: formData.orderType,
        inline: true,
      },
    ];

    if (isStopLimit && formData.triggerPrice) {
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

    const embed = {
      title: `🚨 NEW SETUP: ${formData.pair.toUpperCase()} 🚨`,
      color: color,
      fields: fields,
      timestamp: new Date().toISOString(),
      ...(formData.notes && { description: `**Notes / Analysis**\n${formData.notes}` }),
    };

    const payload = { embeds: [embed] };

    try {
      const response = await fetch(postUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.status} ${response.statusText}`);
      }

      const responseData = await response.json();
      const messageId = responseData.id;

      // Determine entry price for display
      let entry = 'Market';
      if (formData.orderPrice) entry = formData.orderPrice;
      else if (formData.triggerPrice) entry = formData.triggerPrice;

      // --- Record trade signal in Supabase ---
      const { data: dbRecord, error: dbError } = await supabase
        .from('trade_history')
        .insert([
          {
            pair_name: formData.pair.toUpperCase(),
            order_type: formData.orderType,
            order_price: formData.orderPrice ? parseFloat(formData.orderPrice) : null,
            stop_loss_price: formData.stopLoss ? parseFloat(formData.stopLoss) : null,
            take_profit_price: formData.takeProfit ? parseFloat(formData.takeProfit) : null,
            trigger_price: formData.triggerPrice ? parseFloat(formData.triggerPrice) : null,
            notes: formData.notes || null,
            status: 'ACTIVE',
            is_active: true,
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

      const newTrade = {
        id: messageId,
        supabaseId: dbRecord?.id ?? null,
        pair: formData.pair.toUpperCase(),
        orderType: formData.orderType,
        entry: entry,
        timestamp: new Date().toISOString(),
        status: 'ACTIVE',
        originalEmbed: embed,
      };

      saveTrades([newTrade, ...activeTrades]);

      setAlert({ show: true, message: 'Setup successfully broadcasted!', type: 'success' });
      setFormData({
        pair: '',
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
      setAlert({ show: true, message: 'Failed to broadcast setup.', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateTrade = async (trade, actionType) => {
    const webhookUrl = import.meta.env.VITE_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

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

    // Filter out old update status if it exists
    const filteredFields = trade.originalEmbed.fields.filter(f => f.name !== 'Update Status');
    
    const updatedEmbed = {
      ...trade.originalEmbed,
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

    const payload = { embeds: [updatedEmbed] };

    try {
      const baseUrl = webhookUrl.split('?')[0]; // Remove any search params from base url
      const patchUrl = `${baseUrl}/messages/${trade.id}`;

      const response = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Failed to update message: ${response.status}`);
      }

      // --- Sync status to Supabase ---
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
        };
        
        if (actionType === 'TRIGGERED') {
          updatePayload.triggered_at = new Date().toISOString();
        }

        const { error: updateError } = await supabase
          .from('trade_history')
          .update(updatePayload)
          .eq('id', trade.supabaseId);

        if (updateError) {
          console.error('Supabase update error:', updateError);
        }
      }

      // Update trade with new embed so subsequent updates preserve it
      const updatedTrade = { ...trade, originalEmbed: updatedEmbed, status: actionType };
      const newTrades = activeTrades.map(t => t.id === trade.id ? updatedTrade : t);
      saveTrades(newTrades);
    } catch (error) {
      console.error(error);
      alert('Failed to update the trade on Discord.');
    }
  };

  const handleToggleActive = async (trade) => {
    const newIsClosed = !trade.isClosed;
    
    // Update Supabase
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
        .from('trade_history')
        .update(updatePayload)
        .eq('id', trade.supabaseId);
        
      if (updateError) {
        console.error('Supabase update error:', updateError);
        alert('Failed to update status in database.');
        return;
      }
    }
    
    // Update local state
    const updatedTrade = { ...trade, isClosed: newIsClosed };
    const newTrades = activeTrades.map(t => t.id === trade.id ? updatedTrade : t);
    saveTrades(newTrades);
  };

  return (
    <div className="min-h-screen bg-[#0d0f12] text-gray-200 p-4 font-sans flex justify-center items-start pt-10">
      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Main Form Panel */}
        <div className="lg:col-span-5 bg-[#14161a] border border-[#23262e] rounded-lg shadow-2xl p-6 sm:p-8 self-start">
          <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#23262e]">
            <div>
              <h1 className="text-xl font-bold tracking-wider text-white">COMMAND CENTER</h1>
              <p className="text-xs text-gray-500 mt-1 uppercase tracking-widest">Signal Blaster</p>
            </div>
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></div>
          </div>

          {alert.show && (
            <div
              className={`mb-6 p-4 rounded-md text-sm border ${
                alert.type === 'success'
                  ? 'bg-green-900/20 border-green-500/50 text-green-400'
                  : 'bg-red-900/20 border-red-500/50 text-red-400'
              }`}
            >
              {alert.message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Pair/Asset & Order Type Row */}
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
            </div>

            {/* Dynamic Price Inputs */}
            {!isMarket && (
              <div className="bg-[#101216] border border-[#1c1e24] rounded-md p-4 space-y-4">
                <div className={`grid ${isStopLimit ? 'grid-cols-2' : 'grid-cols-1'} gap-4`}>
                  {isStopLimit && (
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
                        required={isStopLimit}
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
              className={`w-full py-4 rounded font-bold uppercase tracking-wider text-sm transition-all duration-200 mt-6 shadow-lg ${
                isBuy
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
          <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#23262e]">
            <h2 className="text-xl font-bold tracking-wider text-white uppercase">Today's Trades</h2>
            <span className="text-xs bg-[#23262e] px-3 py-1 rounded-full font-mono text-gray-300">
              {activeTrades.length} Total
            </span>
          </div>

          {activeTrades.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              <svg className="w-12 h-12 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-sm">No trades added today.</p>
            </div>
          ) : (
            <div className="space-y-4 max-h-[700px] overflow-y-auto pr-2 custom-scrollbar">
              {activeTrades.map((trade) => (
                <div key={trade.id} className="bg-[#0d0f12] border border-[#1c1e24] rounded-md p-4 flex flex-col gap-4">
                  
                  {/* Trade Info Header */}
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${trade.orderType.startsWith('Buy') ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                          {trade.orderType}
                        </span>
                        <span className="font-mono font-bold text-white tracking-wider">{trade.pair}</span>
                      </div>
                      <div className="text-xs text-gray-500 font-mono">
                        Entry: {trade.entry} &bull; {new Date(trade.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                    <button
                      onClick={() => handleToggleActive(trade)}
                      className={`text-[10px] px-2 py-1 rounded font-bold tracking-wider transition-colors uppercase ${
                        trade.isClosed 
                          ? 'bg-gray-800 text-gray-400 hover:bg-gray-700 border border-gray-600' 
                          : 'bg-green-900/30 text-green-400 hover:bg-green-900/50 border border-green-500/30'
                      }`}
                    >
                      {trade.isClosed ? 'Inactive' : 'Active'}
                    </button>
                  </div>

                  {/* Action Buttons */}
                  {trade.isClosed ? (
                    <div className="bg-[#1c1e24] border border-[#23262e] rounded p-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Trade Inactive
                    </div>
                  ) : (
                    <div className={`grid gap-2 ${trade.status !== 'ACTIVE' ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1'}`}>
                      <button
                        onClick={() => handleUpdateTrade(trade, 'TRIGGERED')}
                        disabled={trade.status !== 'ACTIVE'}
                        className={`bg-blue-900/20 border border-blue-500/30 text-blue-400 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide ${
                          trade.status !== 'ACTIVE' ? 'opacity-30 cursor-not-allowed' : 'hover:bg-blue-900/40'
                        }`}
                      >
                        Triggered
                      </button>
                      {trade.status !== 'ACTIVE' && (
                        <>
                          <button
                            onClick={() => handleUpdateTrade(trade, 'TP')}
                            className="bg-yellow-900/20 hover:bg-yellow-900/40 border border-yellow-500/30 text-yellow-400 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide"
                          >
                            TP Hit
                          </button>
                          <button
                            onClick={() => handleUpdateTrade(trade, 'SL')}
                            className="bg-red-900/20 hover:bg-red-900/40 border border-red-500/30 text-red-400 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide"
                          >
                            SL Hit
                          </button>
                          <button
                            onClick={() => handleUpdateTrade(trade, 'CLOSE')}
                            className="bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-300 text-xs py-2 px-2 rounded transition-colors font-semibold tracking-wide"
                          >
                            Close Manual
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandCenter;

import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import './index.css'

function formatMoney(paise) {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function App() {
  const [days, setDays] = useState([]);
  const [currentDay, setCurrentDay] = useState(null);
  const [summary, setSummary] = useState(null);
  const [series, setSeries] = useState(null);
  const [eventsFeed, setEventsFeed] = useState([]);
  const [loading, setLoading] = useState(true);

  const [itemSearch, setItemSearch] = useState('');
  const [sortLost, setSortLost] = useState(false);
  const [activeTab, setActiveTab] = useState('live');
  const [selectedDayId, setSelectedDayId] = useState(null);

  // Poll for current day state and history
  useEffect(() => {
    const fetchState = async () => {
      try {
        const [currRes, daysRes] = await Promise.all([
          fetch('/api/v1/day/current'),
          fetch('/api/v1/days')
        ]);
        
        if (currRes.ok) {
          const curr = await currRes.json();
          setCurrentDay(curr.day_id ? curr : null);
        }
        
        if (daysRes.ok) {
          const d = await daysRes.json();
          setDays(d);
        }
      } catch (err) {
        console.error('Failed to fetch state:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 1000); // 1s polling
    return () => clearInterval(interval);
  }, []);

  const activeDayId = currentDay?.day_id || selectedDayId || (days.length > 0 ? days[days.length - 1]?.day_id : null);
  const isLive = currentDay && activeDayId === currentDay.day_id;

  // Fetch summary, series, and events when active day changes or is updated
  useEffect(() => {
    if (!activeDayId) return;
    
    const fetchDetails = async () => {
      try {
        const [sumRes, serRes, evRes] = await Promise.all([
          fetch(`/api/v1/day/${activeDayId}/summary`),
          fetch(`/api/v1/day/${activeDayId}/series`),
          fetch(`/api/v1/day/${activeDayId}/events?limit=50&order=desc`)
        ]);
        
        if (sumRes.ok) setSummary(await sumRes.json());
        if (serRes.ok) setSeries(await serRes.json());
        if (evRes.ok) {
          const evData = await evRes.json();
          setEventsFeed(evData && Array.isArray(evData.events) ? evData.events : []);
        }
      } catch (err) {
        console.error('Failed to fetch details:', err);
      }
    };

    fetchDetails();
    const interval = setInterval(fetchDetails, 1000);
    return () => clearInterval(interval);
  }, [activeDayId, currentDay?.event_count]);

  const loadHistoricalDay = (dayId) => {
    setCurrentDay(null); // force viewing historical
    setSelectedDayId(dayId);
    setActiveTab('live');
  };

  const getFilteredItems = () => {
    if (!summary?.items) return [];
    let itms = [...summary.items];
    if (itemSearch) {
      const q = itemSearch.toLowerCase();
      itms = itms.filter(i => i.item_id.toLowerCase().includes(q));
    }
    if (sortLost) {
      itms.sort((a, b) => b.lost_revenue - a.lost_revenue);
    }
    return itms;
  };

  const baseCost = summary ? Math.min(summary.baseline.shelf_first_cost, summary.baseline.inventory_only_cost) : 0;
  const statusLabel = summary ? summary.status : (isLive ? currentDay.status : 'idle');

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="brand">MallOps<span style={{ color: 'var(--text-muted)' }}>.AI</span></div>
        <div className="nav-menu">
          <div className={`nav-item ${activeTab === 'live' ? 'active' : ''}`} onClick={() => setActiveTab('live')}>Live Dashboard</div>
          <div className={`nav-item ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>Historical Days</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="header">
          <div>
            <h1>Simulation Dashboard</h1>
            <div data-testid="day-id" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              {activeDayId || 'No active day'}
            </div>
          </div>
          
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div className={`status-badge ${statusLabel === 'running' ? 'running' : ''}`} data-testid="run-status">
              {statusLabel}
            </div>
            {summary && summary.events_total > 0 && (
              <div data-testid="progress" data-value={Math.floor((summary.events_processed / summary.events_total) * 100)} className="progress-badge">
                {Math.floor((summary.events_processed / summary.events_total) * 100)}%
              </div>
            )}
          </div>
        </header>

        <div className="dashboard">
          {activeTab === 'history' ? (
            <div className="fade-in">
              <div className="panel">
                <div className="panel-header">All Historical Days</div>
                <div className="panel-content no-padding">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Day ID</th>
                        <th>Total Cost</th>
                        <th>Savings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {days.map(d => (
                        <tr key={d.day_id} onClick={() => loadHistoricalDay(d.day_id)} style={{ cursor: 'pointer' }}>
                          <td>{d.day_id}</td>
                          <td className="money">{formatMoney(d.total_cost)}</td>
                          <td className="money" style={{ color: 'var(--success)' }}>{formatMoney(d.savings_vs_baseline)}</td>
                        </tr>
                      ))}
                      {days.length === 0 && (
                        <tr><td colSpan="3" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No historical days yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <>
              {!activeDayId && !loading && (
                <div className="empty-state fade-in">
                  <div className="empty-state-icon">📊</div>
                  <h2>No simulation data available</h2>
                  <p>Waiting for the harness to load a day...</p>
                </div>
              )}

              {summary && (
                <div className="fade-in">
              {/* KPI Cards */}
              <div className="metrics-grid">
                <div className="metric-card" data-testid="kpi-total-cost" data-value={summary.totals.total_cost}>
                  <div className="metric-title">Total Cost</div>
                  <div className="metric-value money" style={{ color: 'var(--danger)' }}>{formatMoney(summary.totals.total_cost)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-refill-cost" data-value={summary.totals.refill_cost}>
                  <div className="metric-title">Refill Cost</div>
                  <div className="metric-value money">{formatMoney(summary.totals.refill_cost)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-online-pull-cost" data-value={summary.totals.online_pull_cost}>
                  <div className="metric-title">Online Pull Cost</div>
                  <div className="metric-value money">{formatMoney(summary.totals.online_pull_cost)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-lost-revenue" data-value={summary.totals.lost_revenue}>
                  <div className="metric-title">Lost Revenue</div>
                  <div className="metric-value money">{formatMoney(summary.totals.lost_revenue)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-gross-revenue" data-value={summary.totals.gross_revenue}>
                  <div className="metric-title">Gross Revenue</div>
                  <div className="metric-value money">{formatMoney(summary.totals.gross_revenue)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-baseline-cost" data-value={baseCost}>
                  <div className="metric-title">Baseline Cost</div>
                  <div className="metric-value money">{formatMoney(baseCost)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-baseline-shelf-first" data-value={summary.baseline.shelf_first_cost}>
                  <div className="metric-title">BL: Shelf First</div>
                  <div className="metric-value money">{formatMoney(summary.baseline.shelf_first_cost)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-baseline-inventory-only" data-value={summary.baseline.inventory_only_cost}>
                  <div className="metric-title">BL: Inv Only</div>
                  <div className="metric-value money">{formatMoney(summary.baseline.inventory_only_cost)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-savings" data-value={summary.savings_vs_baseline}>
                  <div className="metric-title">Savings vs Baseline</div>
                  <div className="metric-value money" style={{ color: 'var(--success)' }}>{formatMoney(summary.savings_vs_baseline)}</div>
                </div>
                <div className="metric-card" data-testid="kpi-refill-count" data-value={summary.totals.refill_count}>
                  <div className="metric-title">Refill Count</div>
                  <div className="metric-value">{summary.totals.refill_count}</div>
                </div>
                <div className="metric-card" data-testid="kpi-units-lost" data-value={summary.totals.units_lost}>
                  <div className="metric-title">Units Lost</div>
                  <div className="metric-value">{summary.totals.units_lost}</div>
                </div>
              </div>

              <div className="panels-grid">
                
                {/* Left Column */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                  
                  {/* Cost Chart */}
                  <div className="panel" data-testid="cost-chart">
                    <div className="panel-header">Cumulative Cost Chart</div>
                    <div className="panel-content">
                      {series && series.length > 0 ? (
                        <ResponsiveContainer width="100%" height={300}>
                          <LineChart data={series} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                            <XAxis dataKey="seq" stroke="#888" tick={{ fill: '#888', fontSize: 12 }} />
                            <YAxis stroke="#888" tick={{ fill: '#888', fontSize: 12 }} tickFormatter={(val) => `₹${(val / 100000).toFixed(0)}L`} />
                            <Tooltip 
                              contentStyle={{ backgroundColor: '#1a1f2b', borderColor: '#333', color: '#fff' }}
                              formatter={(value) => formatMoney(value)}
                              labelFormatter={(label) => `Seq: ${label}`}
                            />
                            <Legend />
                            <Line type="monotone" dataKey="cost" stroke="#8884d8" name="Total Cost" dot={false} strokeWidth={2} />
                            <Line type="monotone" dataKey="baseline" stroke="#82ca9d" name="Baseline Cost" dot={false} strokeWidth={2} />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="chart-placeholder" style={{ height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border)', color: 'var(--text-muted)' }}>
                          Loading chart data...
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Items Table */}
                  <div className="panel" data-testid="items-table">
                    <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Items State</span>
                      <div style={{ display: 'flex', gap: '12px' }}>
                        <input 
                          type="text" 
                          data-testid="item-search" 
                          placeholder="Search items..." 
                          value={itemSearch} 
                          onChange={e => setItemSearch(e.target.value)} 
                          style={{ background: 'var(--bg-color)', border: '1px solid var(--border)', color: '#fff', padding: '4px 8px', borderRadius: '4px' }}
                        />
                        <button 
                          data-testid="sort-lost" 
                          onClick={() => setSortLost(!sortLost)}
                          style={{ background: sortLost ? 'var(--accent)' : 'var(--bg-color)', color: '#fff', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}
                        >
                          Sort by Loss
                        </button>
                      </div>
                    </div>
                    <div className="panel-content" style={{ padding: 0 }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Item ID</th>
                            <th>Shelf Qty</th>
                            <th>Lost Rev (paise)</th>
                            <th>Refills</th>
                            <th>Units Pulled</th>
                          </tr>
                        </thead>
                        <tbody>
                          {getFilteredItems().map(item => (
                            <tr key={item.item_id} data-testid={`item-row-${item.item_id}`}>
                              <td>{item.item_id}</td>
                              <td data-testid={`item-shelf-${item.item_id}`} data-value={item.shelf_qty}>{item.shelf_qty}</td>
                              <td data-testid={`item-lost-${item.item_id}`} data-value={item.lost_revenue} className="money">{item.lost_revenue}</td>
                              <td data-testid={`item-refills-${item.item_id}`} data-value={item.refill_count}>{item.refill_count}</td>
                              <td data-testid={`item-pulled-${item.item_id}`} data-value={item.units_pulled}>{item.units_pulled}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Right Column */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                  
                  {/* Event Feed */}
                  <div className="panel" data-testid="event-feed">
                    <div className="panel-header">Event Feed</div>
                    <div className="panel-content" style={{ padding: 0, maxHeight: '400px' }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Seq</th>
                            <th>Type</th>
                            <th>Order ID</th>
                          </tr>
                        </thead>
                        <tbody>
                          {eventsFeed.map(ev => (
                            <tr key={ev.seq}>
                              <td>{ev.seq}</td>
                              <td>{ev.type}</td>
                              <td>{ev.order_id}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                </div>
              </div>
            </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default App

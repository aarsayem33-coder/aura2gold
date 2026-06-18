import React, { useState } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.tsx';
import Login from './pages/Login.tsx';
import TradingTerminal from './pages/TradingTerminal.tsx';
import SignalDashboard from './pages/SignalDashboard.tsx';
import FixedTimeTrading from './pages/FixedTimeTrading.tsx';
import EconomicCalendar from './pages/EconomicCalendar.tsx';
import HighImpactNews from './pages/HighImpactNews.tsx';
import TradeTheNews from './pages/TradeTheNews.tsx';
import FuturePredictions from './pages/FuturePredictions.tsx';
import Projections from './pages/Projections.tsx';
import AIAnalysis from './pages/AIAnalysis.tsx';
import TradeJournal from './pages/TradeJournal.tsx';
import Dashboard from './pages/Dashboard.tsx';
import AlertFeed from './pages/AlertFeed.tsx';
import RulesManagement from './pages/RulesManagement.tsx';
import MT5Connection from './pages/MT5Connection.tsx';
import NotificationSettings from './pages/NotificationSettings.tsx';
import AlertHistory from './pages/AlertHistory.tsx';
import ReportsOverview from './pages/reports/ReportsOverview.tsx';
import ForexOutcomes from './pages/reports/ForexOutcomes.tsx';
import FixedOutcomes from './pages/reports/FixedOutcomes.tsx';
import SignalLog from './pages/reports/SignalLog.tsx';
import CalibrationReport from './pages/reports/CalibrationReport.tsx';
import BacktestReport from './pages/reports/BacktestReport.tsx';
import Admin from './pages/Admin.tsx';
import HistoricalData from './pages/HistoricalData.tsx';
import AiSignals from './pages/AiSignals.tsx';
import { Mt5StreamProvider } from './mt5Api.ts';

const AUTH_STORAGE_KEY = 'aura-gold-authenticated';

function getStoredAuth() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(AUTH_STORAGE_KEY) === 'true';
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(getStoredAuth);

  const handleLogin = (remember: boolean) => {
    setIsAuthenticated(true);
    if (remember) window.localStorage.setItem(AUTH_STORAGE_KEY, 'true');
    else window.localStorage.removeItem(AUTH_STORAGE_KEY);
  };

  const handleLogout = () => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    setIsAuthenticated(false);
  };

  return (
    <HashRouter>
      <Routes>
        <Route 
          path="/login" 
          element={
            isAuthenticated ? <Navigate to="/" /> : <Login onLogin={handleLogin} />
          } 
        />
        
        {/* Protected Routes wrapped in Layout */}
        <Route 
          path="/" 
          element={
            isAuthenticated ? (
              <Mt5StreamProvider>
                <Layout onLogout={handleLogout} />
              </Mt5StreamProvider>
            ) : (
              <Navigate to="/login" />
            )
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="terminal" element={<TradingTerminal />} />
          <Route path="signals" element={<SignalDashboard />} />
          <Route path="fixed-time" element={<FixedTimeTrading />} />
          <Route path="future-predictions" element={<FuturePredictions />} />
          <Route path="projections" element={<Projections />} />
          <Route path="calendar" element={<EconomicCalendar />} />
          <Route path="news-high-impact" element={<HighImpactNews />} />
          <Route path="trade-news" element={<TradeTheNews />} />
          <Route path="analysis" element={<AIAnalysis />} />
          <Route path="journal" element={<TradeJournal />} />
          <Route path="feed" element={<AlertFeed />} />
          <Route path="rules" element={<RulesManagement />} />
          <Route path="mt5" element={<MT5Connection />} />
          <Route path="notifications" element={<NotificationSettings />} />
          <Route path="history" element={<AlertHistory />} />
          <Route path="reports" element={<ReportsOverview />} />
          <Route path="reports/forex" element={<ForexOutcomes />} />
          <Route path="reports/fixed" element={<FixedOutcomes />} />
          <Route path="reports/signals" element={<SignalLog />} />
          <Route path="reports/calibration" element={<CalibrationReport />} />
          <Route path="reports/backtest" element={<BacktestReport />} />
          <Route path="data" element={<HistoricalData />} />
          <Route path="ai-signals" element={<AiSignals />} />
          <Route path="admin" element={<Admin />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

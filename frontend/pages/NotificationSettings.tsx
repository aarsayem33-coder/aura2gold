import React, { useState, useEffect } from 'react';
import { Smartphone, Mail, MessageSquare, Send, CheckCircle2, XCircle, Bell, Volume2 } from 'lucide-react';
import { fetchEmailAlertSettings, saveEmailAlertSettings, useMt5Stream } from '../mt5Api';
import { formatBdDateTime } from '../utils/time';
import { playAlertSound, requestNotificationPermission, showBrowserNotification } from '../utils/notifications';
import type { EmailAlertSettings } from '../types';

const defaultEmailAlertSettings: EmailAlertSettings = {
  forexScanner: false,
  fixedTime: true,
  postNewsForex: false,
  postNewsFixed: true,
  highImpactNews: true,
  aiTracked: false,
  forecast: true,
  signalTracker: true,
  forexMinGrade: 'A_SETUP',
  forexMinQuality: 'A_SIGNAL',
  fixedTimeMinTier: 'QUALITY_SIGNAL',
  postNewsForexMinGrade: 'A_NEWS_SETUP',
  postNewsFixedMinTier: 'QUALITY_SIGNAL',
};

type EmailRouteKey = 'forexScanner' | 'fixedTime' | 'postNewsForex' | 'postNewsFixed' | 'highImpactNews' | 'aiTracked' | 'forecast' | 'signalTracker';
type EmailSelectKey = 'forexMinGrade' | 'forexMinQuality' | 'fixedTimeMinTier' | 'postNewsForexMinGrade' | 'postNewsFixedMinTier';

const emailSignalOptions: Array<{ key: EmailRouteKey; title: string; description: string; note: string }> = [
  { key: 'forexScanner', title: 'Forex Scanner Signals', description: 'Regular Forex scanner trade emails with SL/TP plans.', note: 'Uses backend minimum grade' },
  { key: 'fixedTime', title: 'Fixed-Time Trade Signals', description: 'Fixed-time direction prediction emails.', note: 'QUALITY_SIGNAL only' },
  { key: 'postNewsForex', title: 'Post-News Forex Signals', description: 'Forex entries after actual release, reaction, and blackout.', note: 'News-confirmed Forex only' },
  { key: 'postNewsFixed', title: 'Post-News Fixed-Time Signals', description: 'Fixed-time variants of post-news entries.', note: 'QUALITY_SIGNAL only' },
  { key: 'highImpactNews', title: 'High Impact News Reminders', description: 'Pre-release and actual-value economic news emails.', note: 'Calendar/news alerts' },
  { key: 'aiTracked', title: 'AI Tracked Projection Emails', description: 'Emails when tracked AI entry projections trigger.', note: 'Tracked entries only' },
  { key: 'forecast', title: 'Execution Forecast Emails', description: 'When a favorable setup is forecast to become executable: created + ~10m, ~5m, and at the predicted time.', note: 'Timing forecast · score ≥ 60 · times in BDT' },
  { key: 'signalTracker', title: 'Signal Tracker — Close / Manage Alerts', description: 'Live trade management: emails to CLOSE NOW on danger (near stop, opposite signal, news, counter-breaker) or MANAGE on TP hit / profit give-back.', note: 'Active trades only · advisory early warning' },
];

const forexGradeOptions = [
  { value: 'B_SETUP', label: 'B Setup and above' },
  { value: 'A_SETUP', label: 'A Setup and above' },
  { value: 'A_PLUS_SETUP', label: 'A+ Setup only' },
] as const;

const forexQualityOptions = [
  { value: 'B_SIGNAL', label: 'B Signal and above' },
  { value: 'A_SIGNAL', label: 'A Signal and above' },
  { value: 'A_PLUS_SIGNAL', label: 'A+ Signal only' },
] as const;

const fttTierOptions = [
  { value: 'QUALITY_SIGNAL', label: 'QUALITY_SIGNAL only' },
  { value: 'TRADE_SIGNAL', label: 'TRADE_SIGNAL and QUALITY_SIGNAL' },
] as const;

const newsGradeOptions = [
  { value: 'B_NEWS_SETUP', label: 'B News Setup and above' },
  { value: 'A_NEWS_SETUP', label: 'A News Setup and above' },
  { value: 'A_PLUS_NEWS_SETUP', label: 'A+ News Setup only' },
] as const;

export default function NotificationSettings() {
  const { logs, refresh } = useMt5Stream();
  const [mqId, setMqId] = useState('12345678');
  const [email, setEmail] = useState('aarsayem002@gmail.com');
  const [whatsapp, setWhatsapp] = useState('+1234567890');
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [emailSettings, setEmailSettings] = useState<EmailAlertSettings>(defaultEmailAlertSettings);
  const [emailSettingsStatus, setEmailSettingsStatus] = useState<string | null>(null);
  const [savingEmailSettings, setSavingEmailSettings] = useState(false);
  const [emailSettingsMeta, setEmailSettingsMeta] = useState<{ emailTo?: string | null; newsEmailTo?: string | null; smtpConfigured?: boolean }>({});

  const [browserNotifications, setBrowserNotifications] = useState(() => {
    if (typeof window === 'undefined') return false;
    const val = window.localStorage.getItem('aura-gold-browser-notifications');
    if (val === null) {
      return 'Notification' in window && Notification.permission === 'granted';
    }
    return val === 'true';
  });
  const [soundAlerts, setSoundAlerts] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('aura-gold-sound-alerts') !== 'false';
  });
  const [notificationPermission, setNotificationPermission] = useState(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';
    return Notification.permission;
  });

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchEmailAlertSettings()
      .then((payload) => {
        if (cancelled) return;
        setEmailSettings({ ...defaultEmailAlertSettings, ...payload.settings });
        setEmailSettingsMeta({ emailTo: payload.email_to, newsEmailTo: payload.news_email_to, smtpConfigured: payload.smtpConfigured });
      })
      .catch((error) => {
        if (!cancelled) setEmailSettingsStatus(error instanceof Error ? error.message : 'Failed to load email routing settings');
      });
    return () => { cancelled = true; };
  }, []);

  const handleNotificationToggle = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      alert('Browser notifications are not supported in this browser.');
      return;
    }

    if (Notification.permission === 'default') {
      const result = await requestNotificationPermission();
      setNotificationPermission(result);
      if (result === 'granted') {
        window.localStorage.setItem('aura-gold-browser-notifications', 'true');
        setBrowserNotifications(true);
        showBrowserNotification('Notifications Enabled', {
          body: 'You will now receive real-time signals and predictions.',
        });
      } else {
        window.localStorage.setItem('aura-gold-browser-notifications', 'false');
        setBrowserNotifications(false);
      }
    } else if (Notification.permission === 'denied') {
      alert('Notification permission has been blocked. Please enable notifications in your browser settings for this site.');
    } else {
      const nextValue = !browserNotifications;
      window.localStorage.setItem('aura-gold-browser-notifications', String(nextValue));
      setBrowserNotifications(nextValue);
      if (nextValue) {
        showBrowserNotification('Notifications Enabled', {
          body: 'You will now receive real-time signals and predictions.',
        });
      }
    }
  };

  const handleSoundToggle = () => {
    const nextValue = !soundAlerts;
    window.localStorage.setItem('aura-gold-sound-alerts', String(nextValue));
    setSoundAlerts(nextValue);
    if (nextValue) {
      playAlertSound();
    }
  };

  const handleEmailSettingToggle = (key: EmailRouteKey) => {
    setEmailSettings((current) => ({ ...current, [key]: !current[key] }));
    setEmailSettingsStatus(null);
  };

  const handleEmailSettingSelect = (key: EmailSelectKey, value: string) => {
    setEmailSettings((current) => ({ ...current, [key]: value as EmailAlertSettings[EmailSelectKey] }));
    setEmailSettingsStatus(null);
  };

  const handleSaveEmailSettings = async () => {
    setSavingEmailSettings(true);
    setEmailSettingsStatus(null);
    try {
      const payload = await saveEmailAlertSettings(emailSettings);
      setEmailSettings({ ...defaultEmailAlertSettings, ...payload.settings });
      setEmailSettingsStatus('Email routing settings saved.');
    } catch (error) {
      setEmailSettingsStatus(error instanceof Error ? error.message : 'Failed to save email routing settings');
    } finally {
      setSavingEmailSettings(false);
    }
  };

  const triggerTestNotification = () => {
    if (Notification.permission !== 'granted') {
      alert('Please enable browser notifications first by toggling the switch.');
      return;
    }
    showBrowserNotification('Aura Gold Test Alert', {
      body: 'XAUUSD [M15] — Buy signal generated with 82% confidence.',
      bypassSettings: true,
    });
  };

  const sendTestEmail = async () => {
    setTesting(true);
    setTestStatus(null);
    try {
      const response = await fetch('/api/notifications/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: email,
          subject: 'Aura Gold Notification Test',
          text: 'Test email notification from Aura Gold Alerts.',
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error?.error || `Email test failed: ${response.status}`);
      }
      setTestStatus(`Test email sent to ${email}`);
      await refresh();
    } catch (error) {
      setTestStatus(error instanceof Error ? error.message : 'Email test failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Notification Settings</h2>
        <p className="text-slate-500 text-sm mt-1 font-medium">Configure where real MT5 alerts are sent</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-card">
            <h3 className="text-lg font-bold text-slate-900 mb-6 border-b border-slate-100 pb-3">Channel Configuration</h3>
            <div className="space-y-6">
              <div>
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                  <Smartphone size={18} className="text-blue-500" /> MetaQuotes ID (MT5 App)
                </label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={mqId}
                    onChange={(event) => setMqId(event.target.value)}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all"
                    placeholder="Enter ID from MT5 Mobile App"
                  />
                  <button className="px-5 py-2.5 bg-white border border-slate-200 text-slate-400 rounded-xl text-sm font-bold shadow-sm cursor-not-allowed" disabled>
                    Coming Soon
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">Find this in MT5 Mobile App {'->'} Settings {'->'} Messages</p>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                  <Mail size={18} className="text-red-500" /> Email Address
                </label>
                <div className="flex gap-3">
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all"
                  />
                  <button onClick={sendTestEmail} disabled={testing} className="px-5 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-700 rounded-xl text-sm font-bold transition-all shadow-sm disabled:opacity-60">
                    {testing ? 'Sending...' : 'Test'}
                  </button>
                </div>
                {testStatus && <p className="text-xs text-slate-500 mt-2 font-semibold">{testStatus}</p>}
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                  <MessageSquare size={18} className="text-emerald-500" /> WhatsApp Number
                </label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={whatsapp}
                    onChange={(event) => setWhatsapp(event.target.value)}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all"
                    placeholder="+1234567890"
                  />
                  <button className="px-5 py-2.5 bg-white border border-slate-200 text-slate-400 rounded-xl text-sm font-bold shadow-sm cursor-not-allowed" disabled>
                    Coming Soon
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-2 font-medium">WhatsApp delivery is not implemented yet. Email delivery is live.</p>
              </div>

              <div className="pt-6 border-t border-slate-100">
                <button className="w-full flex items-center justify-center gap-2 bg-gold-500 text-white font-bold py-3.5 px-4 rounded-xl shadow-sm opacity-70 cursor-not-allowed" disabled>
                  <Send size={18} /> Saved in Backend Env for Now
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-card">
            <h3 className="text-lg font-bold text-slate-900 mb-6 border-b border-slate-100 pb-3">Browser & Local Alerts</h3>
            <div className="space-y-6">
              <div className="flex items-center justify-between p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="flex items-start gap-3">
                  <Bell size={20} className="text-blue-500 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-bold text-slate-800">Browser Notifications</h4>
                    <p className="text-xs text-slate-500 mt-0.5 font-medium">Show desktop popups for Forex & FTT signals</p>
                    <p className="text-[10px] text-slate-400 mt-1 font-semibold uppercase">
                      Status: {notificationPermission === 'granted' ? 'Active' : notificationPermission === 'denied' ? 'Blocked' : 'Click Switch to Enable'}
                    </p>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={browserNotifications && notificationPermission === 'granted'}
                    onChange={handleNotificationToggle}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
                </label>
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="flex items-start gap-3">
                  <Volume2 size={20} className="text-emerald-500 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-bold text-slate-800">Sound Alerts</h4>
                    <p className="text-xs text-slate-500 mt-0.5 font-medium">Play a premium chime sound for incoming alerts</p>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={soundAlerts}
                    onChange={handleSoundToggle}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
                </label>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={triggerTestNotification}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-sm font-bold shadow-sm transition-all border border-slate-200"
                >
                  Test Notification
                </button>
                <button
                  onClick={playAlertSound}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-sm font-bold shadow-sm transition-all border border-slate-200"
                >
                  Test Chime
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-card">
            <div className="mb-6 border-b border-slate-100 pb-3">
              <h3 className="text-lg font-bold text-slate-900">Signal Email Routing</h3>
              <p className="mt-1 text-xs font-semibold text-slate-500">Choose which signal systems are allowed to send email alerts.</p>
            </div>
            <div className="space-y-3">
              {emailSignalOptions.map((option) => (
                <div key={option.key} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div>
                    <h4 className="text-sm font-bold text-slate-800">{option.title}</h4>
                    <p className="mt-0.5 text-xs font-medium text-slate-500">{option.description}</p>
                    <p className="mt-1 text-[10px] font-black uppercase tracking-wider text-amber-600">{option.note}</p>
                  </div>
                  <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={emailSettings[option.key]}
                      onChange={() => handleEmailSettingToggle(option.key)}
                      className="sr-only peer"
                    />
                    <div className="h-6 w-11 rounded-full bg-slate-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-gold-500 peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                  </label>
                </div>
              ))}
            </div>
            <div className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
              <div>
                <label className="text-xs font-black uppercase tracking-wider text-slate-500">Forex Minimum Setup</label>
                <select
                  value={emailSettings.forexMinGrade}
                  onChange={(event) => handleEmailSettingSelect('forexMinGrade', event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800 outline-none focus:border-gold-500"
                >
                  {forexGradeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-black uppercase tracking-wider text-slate-500">Forex Minimum Signal</label>
                <select
                  value={emailSettings.forexMinQuality}
                  onChange={(event) => handleEmailSettingSelect('forexMinQuality', event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800 outline-none focus:border-gold-500"
                >
                  {forexQualityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-black uppercase tracking-wider text-slate-500">Fixed-Time Minimum</label>
                <select
                  value={emailSettings.fixedTimeMinTier}
                  onChange={(event) => handleEmailSettingSelect('fixedTimeMinTier', event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800 outline-none focus:border-gold-500"
                >
                  {fttTierOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-black uppercase tracking-wider text-slate-500">Post-News Forex Minimum</label>
                <select
                  value={emailSettings.postNewsForexMinGrade}
                  onChange={(event) => handleEmailSettingSelect('postNewsForexMinGrade', event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800 outline-none focus:border-gold-500"
                >
                  {newsGradeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-black uppercase tracking-wider text-slate-500">Post-News Fixed Minimum</label>
                <select
                  value={emailSettings.postNewsFixedMinTier}
                  onChange={(event) => handleEmailSettingSelect('postNewsFixedMinTier', event.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800 outline-none focus:border-gold-500"
                >
                  {fttTierOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-5 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
              WATCH_ONLY and NO_TRADE are never emailed. Fixed-time filters only choose between QUALITY_SIGNAL-only and TRADE_SIGNAL-or-better.
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs font-semibold text-slate-500">
                <p>Trade emails: {emailSettingsMeta.emailTo || 'not configured'}</p>
                <p>News emails: {emailSettingsMeta.newsEmailTo || emailSettingsMeta.emailTo || 'not configured'} · SMTP {emailSettingsMeta.smtpConfigured ? 'configured' : 'not configured'}</p>
              </div>
              <button
                onClick={handleSaveEmailSettings}
                disabled={savingEmailSettings}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-gold-500 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-gold-600 disabled:opacity-60"
              >
                <Send size={16} /> {savingEmailSettings ? 'Saving...' : 'Save Email Routing'}
              </button>
            </div>
            {emailSettingsStatus && <p className="mt-3 text-xs font-bold text-slate-500">{emailSettingsStatus}</p>}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-card flex flex-col">
          <h3 className="text-lg font-bold text-slate-900 mb-6 border-b border-slate-100 pb-3">Recent Delivery Logs</h3>
          <div className="flex-1 overflow-y-auto pr-2 space-y-3">
            {logs.map((log) => (
              <div key={log.id} className="p-4 rounded-xl bg-slate-50 border border-slate-100 flex items-start justify-between hover:border-slate-200 transition-colors">
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-sm font-bold text-slate-800">{log.channel}</span>
                    <span className="text-xs font-medium text-slate-400">{formatBdDateTime(log.timestamp)}</span>
                  </div>
                  <p className="text-xs text-slate-600 font-mono bg-white px-2 py-1 rounded border border-slate-100 inline-block">{log.recipient}</p>
                  {log.signalId && <p className="text-xs font-medium text-slate-400 mt-2">Signal: {log.signalId}</p>}
                  {log.error && <p className="text-xs font-semibold text-red-500 mt-2">Error: {log.error}</p>}
                </div>
                <div className="mt-1">
                  {log.status === 'Success' ? <CheckCircle2 size={22} className="text-emerald-500" /> : <XCircle size={22} className="text-red-500" />}
                </div>
              </div>
            ))}
            {!logs.length && <p className="text-sm font-medium text-slate-400">No email delivery logs yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

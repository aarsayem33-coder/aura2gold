import React, { useState, useEffect, useRef } from 'react';
import { Mail, Send, CheckCircle2, XCircle, Bell, Volume2, Route, SlidersHorizontal, FlaskConical, Filter, ScrollText, MonitorSmartphone, ChevronDown, Wallet } from 'lucide-react';
import { fetchEmailAlertSettings, saveEmailAlertSettings, fetchStrategies, useMt5Stream } from '../mt5Api';
import { formatBdDateTime } from '../utils/time';
import { playAlertSound, requestNotificationPermission, showBrowserNotification } from '../utils/notifications';
import type { EmailAlertSettings, StrategyMeta } from '../types';

const STRATEGY_LAB_POPUP_GATE = 75; // display only — matches backend STRATEGY_LAB_ALERT_MIN_SCORE default

const defaultEmailAlertSettings: EmailAlertSettings = {
  forexScanner: false,
  fixedTime: true,
  postNewsForex: false,
  postNewsFixed: true,
  highImpactNews: true,
  aiTracked: false,
  forecast: true,
  signalTracker: true,
  breakout: true,
  breakoutEmailMinGrade: 'A',
  strategyLab: false,
  strategyLabMinScore: 75,
  strategyLabMinGrade: 'ANY',
  strategyLabStrategies: {},
  strategyLabFixedTime: false,
  strategyLabFttMinScore: 75,
  strategyLabFttMinGrade: 'ANY',
  strategyLabFttStrategies: {},
  strategyLabRules: {},
  emailRecipients: [],
  emailRecipientRules: {},
  entryReadyAlerts: { enabled: false, minGrade: 'A', strategies: [], symbols: [], timeframes: [] },
  keyLevelProximityAlerts: { enabled: false, sensitivity: 'NORMAL', symbols: [], levelTypes: [] },
  accountRisk: {
    balance: 5000, mode: 'NORMAL', normalRiskPct: 1,
    challenge: {
      preset: 'HOLA_1STEP', phase: 'EVAL', initialBalance: 5000, profitTargetPct: 10,
      dailyLossPct: 3, maxDrawdownPct: 6, drawdownType: 'STATIC', maxRiskPerTradePct: 2,
      riskPerTradePct: 0.5, minTradingDays: 2, consistencyPct: 40, onlyAPlus: true, minRR: 2,
    },
  },
  forexMinGrade: 'A_SETUP',
  forexMinQuality: 'A_SIGNAL',
  fixedTimeMinTier: 'QUALITY_SIGNAL',
  postNewsForexMinGrade: 'A_NEWS_SETUP',
  postNewsFixedMinTier: 'QUALITY_SIGNAL',
};

type EmailRouteKey = 'forexScanner' | 'fixedTime' | 'postNewsForex' | 'postNewsFixed' | 'highImpactNews' | 'aiTracked' | 'forecast' | 'signalTracker' | 'breakout' | 'strategyLab' | 'strategyLabFixedTime';
type EmailSelectKey = 'forexMinGrade' | 'forexMinQuality' | 'fixedTimeMinTier' | 'postNewsForexMinGrade' | 'postNewsFixedMinTier' | 'breakoutEmailMinGrade';

const emailSignalOptions: Array<{ key: EmailRouteKey; title: string; description: string; note: string }> = [
  { key: 'forexScanner', title: 'Forex Scanner Signals', description: 'Regular Forex scanner trade emails with SL/TP plans.', note: 'Uses backend minimum grade' },
  { key: 'fixedTime', title: 'Fixed-Time Trade Signals', description: 'Fixed-time direction prediction emails.', note: 'QUALITY_SIGNAL only' },
  { key: 'postNewsForex', title: 'Post-News Forex Signals', description: 'Forex entries after actual release, reaction, and blackout.', note: 'News-confirmed Forex only' },
  { key: 'postNewsFixed', title: 'Post-News Fixed-Time Signals', description: 'Fixed-time variants of post-news entries.', note: 'QUALITY_SIGNAL only' },
  { key: 'highImpactNews', title: 'High Impact News Reminders', description: 'Pre-release and actual-value economic news emails.', note: 'Calendar/news alerts' },
  { key: 'aiTracked', title: 'AI Tracked Projection Emails', description: 'Emails when tracked AI entry projections trigger.', note: 'Tracked entries only' },
  { key: 'forecast', title: 'Execution Forecast Emails', description: 'When a favorable setup is forecast to become executable: created + ~10m, ~5m, and at the predicted time.', note: 'Timing forecast · score ≥ 60 · times in BDT' },
  { key: 'signalTracker', title: 'Signal Tracker — Close / Manage Alerts', description: 'Live trade management: emails to CLOSE NOW on danger (near stop, opposite signal, news, counter-breaker) or MANAGE on TP hit / profit give-back.', note: 'Active trades only · advisory early warning' },
  { key: 'breakout', title: 'Breakout Alerts (Pre + Confirmed)', description: 'Graded breakouts on well-formed charts (HH/HL or LH/LL into a strong level). Pre-breakout warning (M15/M30/H1) + confirmed-close email (M5/M15/M30/H1). Browser desktop notifications fire generously regardless of this; this gates email only.', note: 'Anti-flood: per-level dedup + hourly cap · pre held to ≥ A' },
  { key: 'strategyLab', title: 'Strategy Lab — High-Score Signals', description: 'Emails for isolated single-strategy signals (ICT breaker, etc.) that score ≥ 75. Popups fire regardless; this just adds email.', note: 'Score ≥ 75 only · isolated lab, not the main system' },
  { key: 'strategyLabFixedTime', title: 'Strategy Lab — Fixed-Time Calls', description: 'Fixed-time (UP/DOWN at next-candle expiry) emails for the same isolated strategy signals. Separate from the Forex strategy-lab emails above.', note: 'Direction call · isolated lab, not the main FTT engine' },
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

const breakoutGradeOptions = [
  { value: 'B', label: 'B and above (confirmed); pre still ≥ A' },
  { value: 'A', label: 'A and above' },
  { value: 'A+', label: 'A+ only' },
] as const;

export default function NotificationSettings() {
  const { logs, refresh } = useMt5Stream();
  const [email, setEmail] = useState('aarsayem002@gmail.com');
  const [newRecipient, setNewRecipient] = useState(''); // input for the signal-recipients list
  const [openRecipient, setOpenRecipient] = useState<string | null>(null); // which recipient's routing filters are expanded
  const [testStatus, setTestStatus] = useState<string | null>(null);
  // ── Redesigned UI state: tab navigation, per-strategy filter accordion, dirty tracking ──
  const [activeTab, setActiveTab] = useState<'routing' | 'strategies' | 'lab' | 'filters' | 'account' | 'device' | 'log'>('routing');
  const [expandedFilter, setExpandedFilter] = useState<string | null>(null);
  // Snapshot of the last LOADED/SAVED settings — the single sticky Save bar appears only
  // when the current settings differ (all sections save through the same endpoint).
  const savedSnapshotRef = useRef<string>(JSON.stringify(defaultEmailAlertSettings));
  const [testing, setTesting] = useState(false);
  const [emailSettings, setEmailSettings] = useState<EmailAlertSettings>(defaultEmailAlertSettings);
  const [emailSettingsStatus, setEmailSettingsStatus] = useState<string | null>(null);
  const [savingEmailSettings, setSavingEmailSettings] = useState(false);
  const [emailSettingsMeta, setEmailSettingsMeta] = useState<{ emailTo?: string | null; newsEmailTo?: string | null; smtpConfigured?: boolean }>({});
  const [labStrategies, setLabStrategies] = useState<StrategyMeta[]>([]);
  const [labSymbols, setLabSymbols] = useState<string[]>([]);

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
        const merged = { ...defaultEmailAlertSettings, ...payload.settings };
        setEmailSettings(merged);
        savedSnapshotRef.current = JSON.stringify(merged);
        setEmailSettingsMeta({ emailTo: payload.email_to, newsEmailTo: payload.news_email_to, smtpConfigured: payload.smtpConfigured });
      })
      .catch((error) => {
        if (!cancelled) setEmailSettingsStatus(error instanceof Error ? error.message : 'Failed to load email routing settings');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchStrategies().then((r) => { if (!cancelled) { setLabStrategies(r.strategies || []); setLabSymbols(r.symbols || []); } }).catch(() => {});
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

  const handleLabMinScore = (value: number) => {
    setEmailSettings((current) => ({ ...current, strategyLabMinScore: Math.max(40, Math.min(95, Math.round(value))) }));
    setEmailSettingsStatus(null);
  };
  const handleLabMinGrade = (value: string) => {
    setEmailSettings((current) => ({ ...current, strategyLabMinGrade: value as EmailAlertSettings['strategyLabMinGrade'] }));
    setEmailSettingsStatus(null);
  };
  const handleLabStrategyToggle = (id: string) => {
    setEmailSettings((current) => {
      const map = { ...(current.strategyLabStrategies || {}) };
      // Empty map = "all enabled"; on first toggle, seed the full set so the choice is explicit.
      if (Object.keys(map).length === 0) for (const s of labStrategies) map[s.id] = true;
      map[id] = !(map[id] ?? true);
      return { ...current, strategyLabStrategies: map };
    });
    setEmailSettingsStatus(null);
  };

  // Fixed-time strategy-lab email rule handlers (independent of the forex rules above).
  const handleLabFttMinScore = (value: number) => {
    setEmailSettings((current) => ({ ...current, strategyLabFttMinScore: Math.max(40, Math.min(95, Math.round(value))) }));
    setEmailSettingsStatus(null);
  };
  const handleLabFttMinGrade = (value: string) => {
    setEmailSettings((current) => ({ ...current, strategyLabFttMinGrade: value as EmailAlertSettings['strategyLabFttMinGrade'] }));
    setEmailSettingsStatus(null);
  };
  const handleLabFttStrategyToggle = (id: string) => {
    setEmailSettings((current) => {
      const map = { ...(current.strategyLabFttStrategies || {}) };
      if (Object.keys(map).length === 0) for (const s of labStrategies) map[s.id] = true;
      map[id] = !(map[id] ?? true);
      return { ...current, strategyLabFttStrategies: map };
    });
    setEmailSettingsStatus(null);
  };

  // ── Per-strategy EMAIL filters (score / grade / symbols / direction) ──
  // Delivery-only refinement layered on the strategy-lab email gates. An absent entry = no
  // extra filtering (the global strategy-lab rules apply). Symbols empty = all symbols.
  const ruleOf = (id: string) => (emailSettings.strategyLabRules || {})[id] || {};
  const updateLabRule = (id: string, patch: Partial<NonNullable<EmailAlertSettings['strategyLabRules']>[string]>) => {
    setEmailSettings((current) => {
      const rules = { ...(current.strategyLabRules || {}) };
      rules[id] = { ...(rules[id] || {}), ...patch };
      return { ...current, strategyLabRules: rules };
    });
    setEmailSettingsStatus(null);
  };
  const handleLabRuleMinScore = (id: string, value: string) => updateLabRule(id, { minScore: value === '' ? undefined : Math.max(40, Math.min(95, Math.round(Number(value)))) });
  const handleLabRuleMinGrade = (id: string, value: string) => updateLabRule(id, { minGrade: (value || 'ANY') as NonNullable<EmailAlertSettings['strategyLabRules']>[string]['minGrade'] });
  const handleLabRuleDirection = (id: string, value: string) => updateLabRule(id, { direction: (value || 'ANY') as 'ANY' | 'LONG' | 'SHORT' });
  const handleLabRuleSymbol = (id: string, symbol: string) => {
    const cur = ruleOf(id).symbols || [];
    const set = new Set(cur.map((s) => s.toUpperCase()));
    const sym = symbol.toUpperCase();
    if (set.has(sym)) set.delete(sym); else set.add(sym);
    updateLabRule(id, { symbols: [...set] });
  };
  const clearLabRule = (id: string) => {
    setEmailSettings((current) => {
      const rules = { ...(current.strategyLabRules || {}) };
      delete rules[id];
      return { ...current, strategyLabRules: rules };
    });
    setEmailSettingsStatus(null);
  };

  // ── Strategy Controller (master per-strategy switch + refinements) ──
  const ctrlOf = (id: string) => (emailSettings.strategyControls || {})[id]
    || labStrategies.find((strategy) => strategy.id === id)?.control
    || { enabled: labStrategies.find((strategy) => strategy.id === id)?.defaultEnabled !== false };
  const updateStrategyControl = (id: string, patch: Partial<NonNullable<EmailAlertSettings['strategyControls']>[string]>) => {
    setEmailSettings((current) => {
      const controls = { ...(current.strategyControls || {}) };
      const fallback = labStrategies.find((strategy) => strategy.id === id)?.control
        || { enabled: labStrategies.find((strategy) => strategy.id === id)?.defaultEnabled !== false };
      controls[id] = { ...fallback, ...(controls[id] || {}), ...patch };
      return { ...current, strategyControls: controls };
    });
    setEmailSettingsStatus(null);
  };
  const handleStrategyEnabledToggle = (id: string) => updateStrategyControl(id, { enabled: !(ctrlOf(id).enabled !== false) });
  const handleStrategyMinScore = (id: string, value: string) => updateStrategyControl(id, { minScore: value === '' ? undefined : Math.max(40, Math.min(95, Math.round(Number(value)))) });
  const handleStrategyDirection = (id: string, value: string) => updateStrategyControl(id, { direction: value as 'ANY' | 'LONG' | 'SHORT' });
  const handleStrategyTimeframe = (id: string, tf: string) => {
    const cur = ctrlOf(id).timeframes || [];
    const set = new Set(cur);
    if (set.has(tf)) set.delete(tf); else set.add(tf);
    updateStrategyControl(id, { timeframes: [...set] });
  };
  const setAllStrategiesEnabled = (on: boolean) => {
    setEmailSettings((current) => {
      const controls = { ...(current.strategyControls || {}) };
      for (const s of labStrategies) controls[s.id] = { ...(controls[s.id] || {}), enabled: on };
      return { ...current, strategyControls: controls };
    });
    setEmailSettingsStatus(null);
  };

  // ── Signal email recipients (multiple) — saved through the same settings store ──
  const addRecipient = () => {
    const e = newRecipient.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setEmailSettingsStatus('Enter a valid email address.'); return; }
    setEmailSettings((current) => {
      const list = current.emailRecipients || [];
      if (list.includes(e) || list.length >= 10) return current;
      return { ...current, emailRecipients: [...list, e] };
    });
    setNewRecipient('');
    setEmailSettingsStatus(null);
  };
  const removeRecipient = (e: string) => {
    setEmailSettings((current) => {
      const rules = { ...(current.emailRecipientRules || {}) };
      delete rules[e];
      return { ...current, emailRecipients: (current.emailRecipients || []).filter((x) => x !== e), emailRecipientRules: rules };
    });
    setEmailSettingsStatus(null);
  };
  // Per-recipient routing (symbols / timeframes). Empty selection = that recipient
  // gets everything — toggling chips narrows what lands in THEIR inbox only.
  const recipientRuleOf = (e: string) => (emailSettings.emailRecipientRules || {})[e] || {};
  const updateRecipientRule = (e: string, patch: { symbols?: string[]; timeframes?: string[] }) => {
    setEmailSettings((current) => {
      const rules = { ...(current.emailRecipientRules || {}) };
      const next = { ...(rules[e] || {}), ...patch };
      if (!(next.symbols || []).length && !(next.timeframes || []).length) delete rules[e];
      else rules[e] = next;
      return { ...current, emailRecipientRules: rules };
    });
    setEmailSettingsStatus(null);
  };
  const toggleRecipientSymbol = (e: string, sym: string) => {
    const cur = (recipientRuleOf(e).symbols || []).map((x) => x.toUpperCase());
    const s = sym.toUpperCase();
    updateRecipientRule(e, { symbols: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  };
  const toggleRecipientTf = (e: string, tf: string) => {
    const cur = recipientRuleOf(e).timeframes || [];
    updateRecipientRule(e, { timeframes: cur.includes(tf) ? cur.filter((x) => x !== tf) : [...cur, tf] });
  };

  // ── At-entry alert (email when an A/A+ signal's entry fills) ──
  const era = emailSettings.entryReadyAlerts || { enabled: false, minGrade: 'A' as const, strategies: [], symbols: [], timeframes: [] };
  const setEra = (patch: Partial<NonNullable<typeof emailSettings.entryReadyAlerts>>) => {
    setEmailSettings((current) => ({ ...current, entryReadyAlerts: { enabled: false, minGrade: 'A', strategies: [], symbols: [], timeframes: [], ...(current.entryReadyAlerts || {}), ...patch } }));
    setEmailSettingsStatus(null);
  };
  const toggleEraList = (key: 'strategies' | 'symbols' | 'timeframes', val: string) => {
    const cur = (era[key] || []) as string[];
    setEra({ [key]: cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val] } as Partial<NonNullable<typeof emailSettings.entryReadyAlerts>>);
  };

  // ── Key-level proximity alert (email when price nears an obvious pool) ──
  const klp = emailSettings.keyLevelProximityAlerts || { enabled: false, sensitivity: 'NORMAL' as const, symbols: [], levelTypes: [] };
  const setKlp = (patch: Partial<NonNullable<typeof emailSettings.keyLevelProximityAlerts>>) => {
    setEmailSettings((current) => ({ ...current, keyLevelProximityAlerts: { enabled: false, sensitivity: 'NORMAL', symbols: [], levelTypes: [], ...(current.keyLevelProximityAlerts || {}), ...patch } }));
    setEmailSettingsStatus(null);
  };
  const toggleKlpList = (key: 'symbols' | 'levelTypes', val: string) => {
    const cur = (klp[key] || []) as string[];
    setKlp({ [key]: cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val] } as Partial<NonNullable<typeof emailSettings.keyLevelProximityAlerts>>);
  };

  // ── Account & position-sizing (balance + Normal/Challenge modes) ──
  const ar = emailSettings.accountRisk || defaultEmailAlertSettings.accountRisk!;
  const setAr = (patch: Partial<NonNullable<typeof emailSettings.accountRisk>>) => {
    setEmailSettings((current) => ({ ...current, accountRisk: { ...defaultEmailAlertSettings.accountRisk!, ...(current.accountRisk || {}), ...patch } }));
    setEmailSettingsStatus(null);
  };
  const setChallenge = (patch: Partial<NonNullable<typeof emailSettings.accountRisk>['challenge']>) => {
    setEmailSettings((current) => {
      const base = current.accountRisk || defaultEmailAlertSettings.accountRisk!;
      return { ...current, accountRisk: { ...base, challenge: { ...base.challenge, ...patch } } };
    });
    setEmailSettingsStatus(null);
  };

  const handleSaveEmailSettings = async () => {
    setSavingEmailSettings(true);
    setEmailSettingsStatus(null);
    try {
      const payload = await saveEmailAlertSettings(emailSettings);
      const merged = { ...defaultEmailAlertSettings, ...payload.settings };
      setEmailSettings(merged);
      savedSnapshotRef.current = JSON.stringify(merged);
      setEmailSettingsStatus('Settings saved.');
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

  // ── Derived values for the redesigned UI ──────────────────────────────────
  const dirty = JSON.stringify(emailSettings) !== savedSnapshotRef.current;
  const routesOn = emailSignalOptions.filter((o) => emailSettings[o.key]).length;
  const strategiesOn = labStrategies.filter((s) => ctrlOf(s.id).enabled !== false).length;
  const filteredCount = labStrategies.filter((s) => {
    const r = ruleOf(s.id);
    return r.minScore !== undefined || (r.minGrade && r.minGrade !== 'ANY') || (r.symbols || []).length > 0 || (r.direction && r.direction !== 'ANY');
  }).length;

  // Routing groups — related toggles together so the list scans in seconds.
  const routeGroups: { label: string; keys: EmailRouteKey[] }[] = [
    { label: 'Core signals', keys: ['forexScanner', 'fixedTime'] },
    { label: 'News', keys: ['postNewsForex', 'postNewsFixed', 'highImpactNews'] },
    { label: 'Advisory & tracking', keys: ['aiTracked', 'forecast', 'signalTracker', 'breakout'] },
    { label: 'Strategy Lab', keys: ['strategyLab', 'strategyLabFixedTime'] },
  ];

  // Compact primitives (kept inside the component — they close over nothing).
  const Toggle = ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center">
      <input type="checkbox" checked={checked} onChange={onChange} className="peer sr-only" />
      <div className="h-5 w-9 rounded-full bg-slate-200 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:bg-gold-500 peer-checked:after:translate-x-4"></div>
    </label>
  );
  const gradeSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 outline-none focus:border-gold-500">
      <option value="ANY">Any grade</option>
      <option value="B">B and above</option>
      <option value="A">A and above</option>
      <option value="A+">A+ only</option>
    </select>
  );
  const thresholdSelect = (label: string, value: string, key: EmailSelectKey, options: readonly { value: string; label: string }[]) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold text-slate-500">{label}</span>
      <select value={value} onChange={(e) => handleEmailSettingSelect(key, e.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:border-gold-500">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );

  const tabs: { key: typeof activeTab; label: string; icon: React.ReactNode; badge?: string }[] = [
    { key: 'routing', label: 'Routing', icon: <Route size={14} />, badge: `${routesOn} on` },
    { key: 'strategies', label: 'Strategies', icon: <SlidersHorizontal size={14} />, badge: labStrategies.length ? `${strategiesOn}/${labStrategies.length}` : undefined },
    { key: 'lab', label: 'Lab Rules', icon: <FlaskConical size={14} /> },
    { key: 'filters', label: 'Filters', icon: <Filter size={14} />, badge: filteredCount ? `${filteredCount}` : undefined },
    { key: 'account', label: 'Account & Sizing', icon: <Wallet size={14} />, badge: ar.mode === 'BOTH' ? 'N+C' : ar.mode === 'CHALLENGE' ? 'CHAL' : 'NORM' },
    { key: 'device', label: 'Device & Test', icon: <MonitorSmartphone size={14} /> },
    { key: 'log', label: 'Delivery Log', icon: <ScrollText size={14} />, badge: logs.length ? `${logs.length}` : undefined },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-24">
      {/* Header — title + live delivery status at a glance */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">Notifications</h2>
          <p className="mt-0.5 text-sm font-medium text-slate-500">Which signals reach you, and where.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${emailSettingsMeta.smtpConfigured ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
            <Mail size={11} /> {emailSettingsMeta.smtpConfigured ? emailSettingsMeta.emailTo || 'Email ready' : 'SMTP not configured'}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${notificationPermission === 'granted' && browserNotifications ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
            <Bell size={11} /> Popups {notificationPermission === 'granted' && browserNotifications ? 'on' : 'off'}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${soundAlerts ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
            <Volume2 size={11} /> Sound {soundAlerts ? 'on' : 'off'}
          </span>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="sticky top-0 z-20 -mx-1 overflow-x-auto bg-slate-50 px-1 py-1.5">
        <div className="flex w-max min-w-full gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${activeTab === t.key ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              {t.icon}{t.label}
              {t.badge && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${activeTab === t.key ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{t.badge}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── ROUTING ── */}
      {activeTab === 'routing' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-bold text-slate-900">Signal email routing</h3>
              <p className="text-xs font-medium text-slate-500">Which signal systems may email you. Popups are separate and stay on.</p>
            </div>
            {routeGroups.map((group) => (
              <div key={group.label}>
                <p className="bg-slate-50/70 px-5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">{group.label}</p>
                <div className="divide-y divide-slate-100">
                  {group.keys.map((key) => {
                    const option = emailSignalOptions.find((o) => o.key === key)!;
                    return (
                      <div key={key} className="flex items-center justify-between gap-4 px-5 py-2.5 transition-colors hover:bg-slate-50/60">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-[13px] font-bold text-slate-800">{option.title}</h4>
                            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600">{option.note}</span>
                          </div>
                          <p className="mt-0.5 truncate text-[11px] font-medium text-slate-400" title={option.description}>{option.description}</p>
                        </div>
                        <Toggle checked={emailSettings[key]} onChange={() => handleEmailSettingToggle(key)} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
            <h3 className="text-sm font-bold text-slate-900">Minimum thresholds</h3>
            <p className="mb-3 text-xs font-medium text-slate-500">Below these, a signal is not emailed. WATCH_ONLY and NO_TRADE are never emailed.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {thresholdSelect('Forex minimum setup', emailSettings.forexMinGrade, 'forexMinGrade', forexGradeOptions)}
              {thresholdSelect('Forex minimum signal', emailSettings.forexMinQuality, 'forexMinQuality', forexQualityOptions)}
              {thresholdSelect('Fixed-time minimum', emailSettings.fixedTimeMinTier, 'fixedTimeMinTier', fttTierOptions)}
              {thresholdSelect('Post-news forex minimum', emailSettings.postNewsForexMinGrade, 'postNewsForexMinGrade', newsGradeOptions)}
              {thresholdSelect('Post-news fixed minimum', emailSettings.postNewsFixedMinTier, 'postNewsFixedMinTier', fttTierOptions)}
              {thresholdSelect('Breakout minimum grade', emailSettings.breakoutEmailMinGrade, 'breakoutEmailMinGrade', breakoutGradeOptions)}
            </div>
          </div>
        </div>
      )}

      {/* ── STRATEGIES (Controller) ── */}
      {activeTab === 'strategies' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Strategy controller</h3>
              <p className="text-xs font-medium text-slate-500">Off = silent everywhere (still measured for ranking). Refinements filter which signals alert.</p>
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setAllStrategiesEnabled(true)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50">All on</button>
              <button type="button" onClick={() => setAllStrategiesEnabled(false)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50">All off</button>
            </div>
          </div>
          <div className="divide-y divide-slate-100">
            {!labStrategies.length && <p className="px-5 py-6 text-center text-xs font-medium text-slate-400">No strategies loaded — check the backend connection.</p>}
            {labStrategies.map((s) => {
              const c = ctrlOf(s.id);
              const on = c.enabled !== false;
              const tfs = c.timeframes || [];
              return (
                <div key={s.id} className={`px-5 py-2.5 transition-colors ${on ? 'hover:bg-slate-50/60' : 'bg-slate-50/50'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className={`truncate text-[13px] font-bold ${on ? 'text-slate-800' : 'text-slate-400'}`}>{s.name}</h4>
                        {s.id === 'ict-breaker' && <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">LIVE WINNER</span>}
                        {s.id === 'xau-session-raid' && <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">GOLD ONLY</span>}
                        {!on && <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">MUTED</span>}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">{s.timeframes.join(' · ')}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {on && (
                        <div className="hidden items-center gap-2 sm:flex">
                          <select value={c.minScore ?? ''} onChange={(e) => handleStrategyMinScore(s.id, e.target.value)} title="Minimum score to alert" className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] font-semibold text-slate-600">
                            <option value="">Any score</option>
                            {[65, 70, 75, 80, 85, 90].map((v) => <option key={v} value={v}>≥ {v}</option>)}
                          </select>
                          <select value={c.direction ?? 'ANY'} onChange={(e) => handleStrategyDirection(s.id, e.target.value)} title="Setup direction" className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] font-semibold text-slate-600">
                            <option value="ANY">Both</option>
                            <option value="LONG">Long only</option>
                            <option value="SHORT">Short only</option>
                          </select>
                          <div className="flex items-center gap-1">
                            {s.timeframes.map((tf) => {
                              const active = tfs.length === 0 || tfs.includes(tf);
                              return (
                                <button key={tf} type="button" onClick={() => handleStrategyTimeframe(s.id, tf)} title={active ? `${tf} alerts on` : `${tf} alerts off`}
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition-colors ${active ? 'bg-gold-500 text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}>{tf}</button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      <Toggle checked={on} onChange={() => handleStrategyEnabledToggle(s.id)} />
                    </div>
                  </div>
                  {on && (
                    <div className="mt-2 flex items-center gap-2 sm:hidden">
                      <select value={c.minScore ?? ''} onChange={(e) => handleStrategyMinScore(s.id, e.target.value)} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] font-semibold text-slate-600">
                        <option value="">Any score</option>
                        {[65, 70, 75, 80, 85, 90].map((v) => <option key={v} value={v}>≥ {v}</option>)}
                      </select>
                      <select value={c.direction ?? 'ANY'} onChange={(e) => handleStrategyDirection(s.id, e.target.value)} className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] font-semibold text-slate-600">
                        <option value="ANY">Both</option>
                        <option value="LONG">Long</option>
                        <option value="SHORT">Short</option>
                      </select>
                      <div className="flex items-center gap-1">
                        {s.timeframes.map((tf) => {
                          const active = tfs.length === 0 || tfs.includes(tf);
                          return (
                            <button key={tf} type="button" onClick={() => handleStrategyTimeframe(s.id, tf)}
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${active ? 'bg-gold-500 text-white' : 'bg-slate-100 text-slate-400'}`}>{tf}</button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── LAB RULES (Forex + Fixed-Time, side by side) ── */}
      {activeTab === 'lab' && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Forex framing */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Forex lab emails</h3>
                <p className="text-xs font-medium text-slate-500">TP/SL framing. Popups fire from score ≥ {STRATEGY_LAB_POPUP_GATE} regardless.</p>
              </div>
              <Toggle checked={emailSettings.strategyLab} onChange={() => handleEmailSettingToggle('strategyLab')} />
            </div>
            <div className={`space-y-4 p-5 ${emailSettings.strategyLab ? '' : 'pointer-events-none opacity-45'}`}>
              <div className="flex items-center gap-4">
                <label className="flex-1">
                  <span className="text-[11px] font-semibold text-slate-500">Min score <b className="text-gold-600">{emailSettings.strategyLabMinScore}</b></span>
                  <input type="range" min={40} max={95} step={1} value={emailSettings.strategyLabMinScore} onChange={(e) => handleLabMinScore(Number(e.target.value))} className="mt-1 w-full accent-gold-500" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-slate-500">Min grade</span>
                  {gradeSelect(emailSettings.strategyLabMinGrade, handleLabMinGrade)}
                </label>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">Strategies that email</p>
                <div className="flex flex-wrap gap-1.5">
                  {labStrategies.map((s) => {
                    const map = emailSettings.strategyLabStrategies || {};
                    const enabled = Object.keys(map).length === 0 ? true : (map[s.id] ?? true);
                    return (
                      <button key={s.id} type="button" onClick={() => handleLabStrategyToggle(s.id)} title={s.source || s.id}
                        className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${enabled ? 'border-gold-400 bg-gold-50 text-gold-700' : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300'}`}>
                        {enabled ? '✓ ' : ''}{s.name}
                      </button>
                    );
                  })}
                  {!labStrategies.length && <p className="text-xs font-medium text-slate-400">No strategies loaded.</p>}
                </div>
              </div>
            </div>
          </div>

          {/* Fixed-time framing */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Fixed-time lab emails</h3>
                <p className="text-xs font-medium text-slate-500">UP/DOWN at next-candle expiry. Independent of the forex rules.</p>
              </div>
              <Toggle checked={emailSettings.strategyLabFixedTime} onChange={() => handleEmailSettingToggle('strategyLabFixedTime')} />
            </div>
            <div className={`space-y-4 p-5 ${emailSettings.strategyLabFixedTime ? '' : 'pointer-events-none opacity-45'}`}>
              <div className="flex items-center gap-4">
                <label className="flex-1">
                  <span className="text-[11px] font-semibold text-slate-500">Min score <b className="text-gold-600">{emailSettings.strategyLabFttMinScore}</b></span>
                  <input type="range" min={40} max={95} step={1} value={emailSettings.strategyLabFttMinScore} onChange={(e) => handleLabFttMinScore(Number(e.target.value))} className="mt-1 w-full accent-gold-500" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-slate-500">Min grade</span>
                  {gradeSelect(emailSettings.strategyLabFttMinGrade, handleLabFttMinGrade)}
                </label>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">Strategies that email fixed-time calls</p>
                <div className="flex flex-wrap gap-1.5">
                  {labStrategies.map((s) => {
                    const map = emailSettings.strategyLabFttStrategies || {};
                    const enabled = Object.keys(map).length === 0 ? true : (map[s.id] ?? true);
                    return (
                      <button key={s.id} type="button" onClick={() => handleLabFttStrategyToggle(s.id)} title={s.source || s.id}
                        className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${enabled ? 'border-violet-400 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300'}`}>
                        {enabled ? '✓ ' : ''}{s.name}
                      </button>
                    );
                  })}
                  {!labStrategies.length && <p className="text-xs font-medium text-slate-400">No strategies loaded.</p>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── AT-ENTRY ALERT (one email when an A/A+ signal's entry fills) ── */}
      {activeTab === 'filters' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">At-entry alert</h3>
              <p className="text-xs font-medium text-slate-500">A decision-ready email when an A/A+ LIMIT or STOP entry fills and still passes every safety check. Empty selections = all enabled strategies / symbols / timeframes.</p>
            </div>
            <button
              type="button"
              onClick={() => setEra({ enabled: !era.enabled })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${era.enabled ? 'bg-emerald-500' : 'bg-slate-200'}`}
              title={era.enabled ? 'At-entry alerts ON' : 'At-entry alerts OFF'}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${era.enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
          {era.enabled && (
            <div className="space-y-3 px-5 py-4">
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ['M1 verified', 'Fresh fill inside the order window'],
                  ['Lifecycle clean', 'No stop touch and TP1 not already hit'],
                  ['No chasing', 'Price must remain inside the live entry zone'],
                ].map(([title, note]) => (
                  <div key={title} className="rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2">
                    <p className="text-[10px] font-black uppercase tracking-wider text-emerald-700">{title}</p>
                    <p className="mt-0.5 text-[10px] font-semibold leading-relaxed text-emerald-900/70">{note}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-semibold leading-relaxed text-amber-900">
                Automatically ignored when H4 has reversed against the trade, the trigger failed, the stop was touched, TP1 already traded, the fill is stale, or price moved too far from entry. MARKET-at-signal setups do not create a later at-entry email.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-500">Minimum grade</span>
                {(['A', 'A+'] as const).map((g) => (
                  <button key={g} type="button" onClick={() => setEra({ minGrade: g })} className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${era.minGrade === g ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{g === 'A' ? 'A and A+' : 'A+ only'}</button>
                ))}
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                  Strategies {(era.strategies || []).length ? <span className="text-emerald-600">— {(era.strategies || []).length} selected</span> : <span className="text-slate-400">— none selected = all enabled strategies</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {labStrategies.map((s) => {
                    const on = (era.strategies || []).includes(s.id);
                    const muted = s.control?.enabled === false;
                    return <button key={s.id} type="button" onClick={() => toggleEraList('strategies', s.id)} title={muted ? 'Muted in Strategy Controller; kept visible so it can be removed from this filter.' : undefined} className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : muted ? 'border-slate-200 bg-slate-100 text-slate-400' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{s.name}{muted ? ' (muted)' : ''}</button>;
                  })}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                  Symbols {(era.symbols || []).length ? <span className="text-emerald-600">— {(era.symbols || []).length} selected</span> : <span className="text-slate-400">— none selected = all symbols</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {labSymbols.map((sym) => {
                    const on = (era.symbols || []).includes(sym.toUpperCase());
                    return <button key={sym} type="button" onClick={() => toggleEraList('symbols', sym.toUpperCase())} className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{sym}</button>;
                  })}
                  {!labSymbols.length && <p className="text-xs font-medium text-slate-400">No symbols available (MT5 feed offline) — leave empty for all.</p>}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                  Timeframes {(era.timeframes || []).length ? <span className="text-emerald-600">— {(era.timeframes || []).join(', ')}</span> : <span className="text-slate-400">— none selected = all timeframes</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].map((tf) => {
                    const on = (era.timeframes || []).includes(tf);
                    return <button key={tf} type="button" onClick={() => toggleEraList('timeframes', tf)} className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{tf}</button>;
                  })}
                </div>
              </div>
              <p className="text-[10px] font-medium text-slate-400">Remember to Save. One durable email per signal, only while the fill is fresh (≤10 min). The email includes the entry zone, full trade ticket, sizing, conditions passed, setup reason, H4/H1 context, BDT timing, execution steps, and explicit ignore rules.</p>
            </div>
          )}
        </div>
      )}

      {/* ── KEY-LEVEL PROXIMITY ALERT ── */}
      {activeTab === 'filters' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Key-level proximity alert</h3>
              <p className="text-xs font-medium text-slate-500">Email when price nears an obvious pool — PDH/PDL and session highs/lows. Volatility-adaptive band (same meaning on gold, FX, indices), two-tier: a heads-up on approach, then a ping at the level. Empty selections = all symbols / all level types.</p>
            </div>
            <button
              type="button"
              onClick={() => setKlp({ enabled: !klp.enabled })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${klp.enabled ? 'bg-emerald-500' : 'bg-slate-200'}`}
              title={klp.enabled ? 'Proximity alerts ON' : 'Proximity alerts OFF'}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${klp.enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
          {klp.enabled && (
            <div className="space-y-3 px-5 py-4">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">Trigger distance (how close before it emails)</p>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ['TIGHT', 'Tight', 'Only when price is right at the level'],
                    ['NORMAL', 'Normal', 'Balanced — recommended'],
                    ['WIDE', 'Wide', 'Earlier heads-up, more emails'],
                  ] as const).map(([val, label, note]) => (
                    <button key={val} type="button" onClick={() => setKlp({ sensitivity: val })} title={note} className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${klp.sensitivity === val ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{label}</button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                  Level types {(klp.levelTypes || []).length ? <span className="text-emerald-600">— {(klp.levelTypes || []).length} selected</span> : <span className="text-slate-400">— none selected = all</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ['PDH_PDL', 'Prev day H/L'],
                    ['ASIAN', 'Asian H/L'],
                    ['LONDON', 'London H/L'],
                    ['NY', 'New York H/L'],
                  ] as const).map(([val, label]) => {
                    const on = (klp.levelTypes || []).includes(val);
                    return <button key={val} type="button" onClick={() => toggleKlpList('levelTypes', val)} className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{label}</button>;
                  })}
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                  Symbols {(klp.symbols || []).length ? <span className="text-emerald-600">— {(klp.symbols || []).length} selected</span> : <span className="text-slate-400">— none selected = all symbols</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {labSymbols.map((sym) => {
                    const on = (klp.symbols || []).includes(sym.toUpperCase());
                    return <button key={sym} type="button" onClick={() => toggleKlpList('symbols', sym.toUpperCase())} className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{sym}</button>;
                  })}
                  {!labSymbols.length && <p className="text-xs font-medium text-slate-400">No symbols available (MT5 feed offline) — leave empty for all.</p>}
                </div>
              </div>
              <p className="text-[10px] font-medium text-slate-400">Remember to Save. One email per level, per tier, per day — the email carries the two-plan read (sweep-and-reject fade vs break-and-hold continuation) with entry, SL, TP1/2/3 and R:R. Only fires while the feed is live. See all approaching levels live on the Live Market Tracker page.</p>
            </div>
          )}
        </div>
      )}

      {/* ── PER-STRATEGY FILTERS (accordion) ── */}
      {activeTab === 'filters' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-bold text-slate-900">Per-strategy email filters</h3>
            <p className="text-xs font-medium text-slate-500">Which symbols and setups each strategy emails. Delivery-only — signal quality, logging and rankings are untouched.</p>
          </div>
          <div className="divide-y divide-slate-100">
            {!labStrategies.length && <p className="px-5 py-6 text-center text-xs font-medium text-slate-400">No strategies loaded — check the backend connection.</p>}
            {labStrategies.map((s) => {
              const rule = ruleOf(s.id);
              const selectedSymbols = (rule.symbols || []).map((x) => x.toUpperCase());
              const active = Boolean(rule.minScore !== undefined || (rule.minGrade && rule.minGrade !== 'ANY') || selectedSymbols.length || (rule.direction && rule.direction !== 'ANY'));
              const open = expandedFilter === s.id;
              const summary = [
                rule.minScore !== undefined ? `score ≥ ${rule.minScore}` : null,
                rule.minGrade && rule.minGrade !== 'ANY' ? `${rule.minGrade}+` : null,
                rule.direction && rule.direction !== 'ANY' ? (rule.direction === 'LONG' ? 'long only' : 'short only') : null,
                selectedSymbols.length ? `${selectedSymbols.length} symbol${selectedSymbols.length > 1 ? 's' : ''}` : null,
              ].filter(Boolean).join(' · ');
              return (
                <div key={s.id}>
                  <button type="button" onClick={() => setExpandedFilter(open ? null : s.id)} className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors hover:bg-slate-50/60">
                    <div className="flex min-w-0 items-center gap-2">
                      <h4 className="truncate text-[13px] font-bold text-slate-800">{s.name}</h4>
                      {active && <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700">Filtered</span>}
                      {summary && <span className="hidden truncate text-[11px] font-medium text-slate-400 sm:inline">{summary}</span>}
                    </div>
                    <ChevronDown size={15} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                  {open && (
                    <div className="space-y-3 border-t border-slate-100 bg-slate-50/50 px-5 py-3.5">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] font-semibold text-slate-500">Min score (blank = default)</span>
                          <input type="number" min={40} max={95} step={1} value={rule.minScore ?? ''} placeholder="default" onChange={(e) => handleLabRuleMinScore(s.id, e.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-bold text-slate-800 outline-none focus:border-emerald-500" />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] font-semibold text-slate-500">Min grade</span>
                          {gradeSelect(rule.minGrade || 'ANY', (v) => handleLabRuleMinGrade(s.id, v))}
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] font-semibold text-slate-500">Setup (direction)</span>
                          <select value={rule.direction || 'ANY'} onChange={(e) => handleLabRuleDirection(s.id, e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:border-emerald-500">
                            <option value="ANY">Both (long &amp; short)</option>
                            <option value="LONG">Long only (BUY)</option>
                            <option value="SHORT">Short only (SELL)</option>
                          </select>
                        </label>
                      </div>
                      <div>
                        <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                          Symbols {selectedSymbols.length ? <span className="text-emerald-600">— {selectedSymbols.length} selected</span> : <span className="text-slate-400">— none selected = all symbols email</span>}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {labSymbols.map((sym) => {
                            const on = selectedSymbols.includes(sym.toUpperCase());
                            return (
                              <button key={sym} type="button" onClick={() => handleLabRuleSymbol(s.id, sym)} className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{sym}</button>
                            );
                          })}
                          {!labSymbols.length && <p className="text-xs font-medium text-slate-400">No symbols available (MT5 feed offline) — leave empty to email all symbols.</p>}
                        </div>
                      </div>
                      {active && (
                        <button type="button" onClick={() => clearLabRule(s.id)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-500 transition-colors hover:border-red-200 hover:text-red-600">Reset filter</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── ACCOUNT & SIZING ── */}
      {activeTab === 'account' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-bold text-slate-900">Account &amp; position sizing</h3>
              <p className="text-xs font-medium text-slate-500">Sets the lot size shown on every emailed signal, and labels the email with the mode. Pure risk math — it never changes which signals fire. Not connected to your real broker/prop account; it sizes off the balance you enter here.</p>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Account balance (USD)</label>
                <div className="flex items-center gap-1">
                  <span className="text-sm font-bold text-slate-400">$</span>
                  <input type="number" min={1} value={ar.balance} onChange={(e) => setAr({ balance: Number(e.target.value) })} className="w-32 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Signal mode</p>
                <div className="flex flex-wrap gap-1.5">
                  {([
                    ['NORMAL', 'Normal', 'Your own account — size by a fixed risk %'],
                    ['CHALLENGE', 'Challenge', 'Prop-firm rules (Hola Prime) — conservative sizing to pass'],
                    ['BOTH', 'Both', 'Show both sizings in one email'],
                  ] as const).map(([val, label, note]) => (
                    <button key={val} type="button" onClick={() => setAr({ mode: val })} title={note} className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${ar.mode === val ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300'}`}>{label}</button>
                  ))}
                </div>
              </div>
              {(ar.mode === 'NORMAL' || ar.mode === 'BOTH') && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Normal risk per trade</label>
                    <input type="number" step={0.1} min={0.05} max={10} value={ar.normalRiskPct} onChange={(e) => setAr({ normalRiskPct: Number(e.target.value) })} className="w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" />
                    <span className="text-sm font-bold text-slate-500">% of ${ar.balance.toLocaleString()} = ${Math.round(ar.balance * ar.normalRiskPct / 100).toLocaleString()} risk/trade</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {(ar.mode === 'CHALLENGE' || ar.mode === 'BOTH') && (
            <div className="rounded-2xl border border-amber-200 bg-white shadow-card">
              <div className="flex items-center justify-between border-b border-amber-100 px-5 py-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Challenge mode — prop-firm rules</h3>
                  <p className="text-xs font-medium text-slate-500">Pre-filled with Hola Prime 1-Step. Edit to match your exact plan. Sizing uses your conservative per-trade risk, well under the hard cap.</p>
                </div>
                <button type="button" onClick={() => setChallenge({ preset: 'HOLA_1STEP', phase: 'EVAL', initialBalance: ar.balance, profitTargetPct: 10, dailyLossPct: 3, maxDrawdownPct: 6, drawdownType: 'STATIC', maxRiskPerTradePct: 2, riskPerTradePct: 0.5, minTradingDays: 2, consistencyPct: 40, minRR: 2 })} className="shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800 hover:bg-amber-100">Reset to Hola 1-Step</button>
              </div>
              <div className="px-5 py-4">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {(['EVAL', 'FUNDED'] as const).map((ph) => (
                    <button key={ph} type="button" onClick={() => setChallenge({ phase: ph })} className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${ar.challenge.phase === ph ? 'border-amber-500 bg-amber-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-amber-300'}`}>{ph === 'EVAL' ? 'Evaluation' : 'Funded'}</button>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {([
                    ['Your per-trade risk %', 'riskPerTradePct', 0.05, 10, 0.05, 'What you actually risk. 0.5% keeps you far from every breach line.'],
                    ['Initial balance $', 'initialBalance', 1, 100000000, 1, 'The challenge account size.'],
                    ['Profit target %', 'profitTargetPct', 1, 100, 0.5, 'Hola 1-Step: 10% of initial.'],
                    ['Max daily loss %', 'dailyLossPct', 0.5, 50, 0.5, '3% of previous day close.'],
                    ['Max drawdown %', 'maxDrawdownPct', 1, 100, 0.5, '6% of initial, static floor.'],
                    ['Per-trade cap %', 'maxRiskPerTradePct', 0.1, 20, 0.1, 'Funded hard cap: 2% of initial.'],
                    ['Min trading days', 'minTradingDays', 0, 60, 1, 'Hola 1-Step: 2 days.'],
                    ['Consistency %', 'consistencyPct', 0, 100, 1, 'No single day > this % of total profit.'],
                    ['Min R:R', 'minRR', 0, 10, 0.1, 'Phase 2 quality gate (stored now).'],
                  ] as const).map(([label, key, min, max, step, note]) => (
                    <div key={key}>
                      <label className="block text-[11px] font-semibold text-slate-500" title={note}>{label}</label>
                      <input type="number" min={min} max={max} step={step} value={(ar.challenge as Record<string, number>)[key]} onChange={(e) => setChallenge({ [key]: Number(e.target.value) } as Partial<NonNullable<typeof emailSettings.accountRisk>['challenge']>)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" />
                    </div>
                  ))}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-500">Drawdown type</label>
                    <div className="mt-0.5 flex gap-1.5">
                      {(['STATIC', 'TRAILING'] as const).map((dt) => (
                        <button key={dt} type="button" onClick={() => setChallenge({ drawdownType: dt })} className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold transition-colors ${ar.challenge.drawdownType === dt ? 'border-amber-500 bg-amber-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-amber-300'}`}>{dt === 'STATIC' ? 'Static' : 'Trailing'}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-[11px] font-semibold leading-relaxed text-emerald-900">
                  Sizing preview: risking {ar.challenge.riskPerTradePct}% of ${Number(ar.challenge.initialBalance).toLocaleString()} = <b>${Math.round(ar.challenge.initialBalance * ar.challenge.riskPerTradePct / 100).toLocaleString()}</b> per trade. Daily-loss room ≈ ${Math.round(ar.challenge.initialBalance * ar.challenge.dailyLossPct / 100).toLocaleString()} · static DD floor ≈ ${Math.round(ar.challenge.initialBalance * (1 - ar.challenge.maxDrawdownPct / 100)).toLocaleString()} · target ≈ ${Math.round(ar.challenge.initialBalance * (1 + ar.challenge.profitTargetPct / 100)).toLocaleString()}. The live progress dashboard + breach guard come next (Phase 2).
                </div>
                <p className="mt-2 text-[10px] font-medium text-slate-400">Remember to Save. Educational risk math — not financial advice. Verify the numbers against your current Hola Prime plan; rules change and vary by plan.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── DEVICE & TEST ── */}
      {activeTab === 'device' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-bold text-slate-900">This device</h3>
              <p className="text-xs font-medium text-slate-500">Browser popups and sound for incoming signals.</p>
            </div>
            <div className="divide-y divide-slate-100">
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Bell size={16} className="shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <h4 className="text-[13px] font-bold text-slate-800">Browser notifications</h4>
                    <p className="text-[11px] font-medium text-slate-400">
                      {notificationPermission === 'granted' ? 'Permission granted' : notificationPermission === 'denied' ? 'Blocked in browser settings' : 'Toggle to request permission'}
                    </p>
                  </div>
                </div>
                <Toggle checked={browserNotifications && notificationPermission === 'granted'} onChange={handleNotificationToggle} />
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Volume2 size={16} className="shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <h4 className="text-[13px] font-bold text-slate-800">Sound alerts</h4>
                    <p className="text-[11px] font-medium text-slate-400">Chime on incoming alerts</p>
                  </div>
                </div>
                <Toggle checked={soundAlerts} onChange={handleSoundToggle} />
              </div>
              <div className="flex gap-2 px-5 py-3">
                <button onClick={triggerTestNotification} className="flex-1 rounded-lg border border-slate-200 bg-slate-50 py-2 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100">Test popup</button>
                <button onClick={playAlertSound} className="flex-1 rounded-lg border border-slate-200 bg-slate-50 py-2 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100">Test chime</button>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-bold text-slate-900">Email channel</h3>
              <p className="text-xs font-medium text-slate-500">Recipient is configured in the backend env; send a test any time.</p>
            </div>
            <div className="space-y-3 p-5">
              <div className="flex gap-2">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-gold-500 focus:bg-white"
                />
                <button onClick={sendTestEmail} disabled={testing} className="shrink-0 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-60">
                  {testing ? 'Sending…' : 'Send test'}
                </button>
              </div>
              {testStatus && <p className="text-[11px] font-semibold text-slate-500">{testStatus}</p>}
              {/* Signal recipients — every signal email goes to ALL of these (max 10). */}
              <div>
                <p className="text-[11px] font-semibold text-slate-500">
                  Signal recipients {(emailSettings.emailRecipients?.length ?? 0) > 0
                    ? <span className="text-emerald-600">— {emailSettings.emailRecipients!.length} address{emailSettings.emailRecipients!.length > 1 ? 'es' : ''}</span>
                    : <span className="text-slate-400">— none set = backend default is used</span>}
                </p>
                <div className="mt-1.5 space-y-1.5">
                  {(emailSettings.emailRecipients || []).map((r) => {
                    const rule = recipientRuleOf(r);
                    const rSyms = (rule.symbols || []).map((x) => x.toUpperCase());
                    const rTfs = rule.timeframes || [];
                    const filtered = rSyms.length > 0 || rTfs.length > 0;
                    const open = openRecipient === r;
                    const summary = filtered
                      ? `${rSyms.length ? `${rSyms.length} symbol${rSyms.length > 1 ? 's' : ''}` : 'All symbols'} · ${rTfs.length ? rTfs.join(' ') : 'All TFs'}`
                      : 'All symbols · All timeframes';
                    return (
                      <div key={r} className={`rounded-lg border ${filtered ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-white'}`}>
                        <div className="flex items-center gap-2 px-2.5 py-1.5">
                          <button type="button" onClick={() => setOpenRecipient(open ? null : r)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                            <span className="truncate text-[11px] font-bold text-emerald-700">{r}</span>
                            <span className={`shrink-0 text-[10px] font-semibold ${filtered ? 'text-emerald-600' : 'text-slate-400'}`}>{summary}</span>
                            <span className="shrink-0 text-[10px] text-slate-400">{open ? '▲' : '▼ edit'}</span>
                          </button>
                          <button type="button" onClick={() => removeRecipient(r)} title="Remove recipient" className="shrink-0 rounded-full text-emerald-500 transition-colors hover:text-red-600">✕</button>
                        </div>
                        {open && (
                          <div className="space-y-2 border-t border-slate-100 px-2.5 py-2">
                            <div>
                              <p className="mb-1 text-[10px] font-semibold text-slate-500">
                                Symbols this address receives {rSyms.length ? <span className="text-emerald-600">— {rSyms.length} selected</span> : <span className="text-slate-400">— none selected = all symbols</span>}
                              </p>
                              <div className="flex flex-wrap gap-1">
                                {labSymbols.map((sym) => {
                                  const on = rSyms.includes(sym.toUpperCase());
                                  return (
                                    <button key={sym} type="button" onClick={() => toggleRecipientSymbol(r, sym)} className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{sym}</button>
                                  );
                                })}
                                {!labSymbols.length && <p className="text-[10px] font-medium text-slate-400">No symbols available (MT5 feed offline) — leave empty for all symbols.</p>}
                              </div>
                            </div>
                            <div>
                              <p className="mb-1 text-[10px] font-semibold text-slate-500">
                                Timeframes {rTfs.length ? <span className="text-emerald-600">— {rTfs.join(', ')}</span> : <span className="text-slate-400">— none selected = all timeframes</span>}
                              </p>
                              <div className="flex flex-wrap gap-1">
                                {['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].map((tf) => {
                                  const on = rTfs.includes(tf);
                                  return (
                                    <button key={tf} type="button" onClick={() => toggleRecipientTf(r, tf)} className={`rounded-md border px-2 py-0.5 text-[10px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'}`}>{tf}</button>
                                  );
                                })}
                              </div>
                            </div>
                            {filtered && (
                              <button type="button" onClick={() => updateRecipientRule(r, { symbols: [], timeframes: [] })} className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500 transition-colors hover:border-red-200 hover:text-red-600">Reset — receive everything</button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1.5 flex gap-2">
                  <input
                    type="email"
                    value={newRecipient}
                    onChange={(e) => setNewRecipient(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipient(); } }}
                    placeholder="add.recipient@email.com"
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-900 outline-none transition-colors focus:border-emerald-500 focus:bg-white"
                  />
                  <button type="button" onClick={addRecipient} className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-100">+ Add</button>
                </div>
                <p className="mt-1 text-[10px] font-medium text-slate-400">Remember to Save — the list applies instantly to all signal emails (forex, fixed-time, lab, breakout, tracker, forecast, news reminders). Click a recipient to route only chosen symbols/timeframes to that address; system emails without a symbol (tests, daily digests) always go to everyone.</p>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-500">
                <p>Trade emails → <b className="text-slate-700">{emailSettingsMeta.emailTo || 'not configured'}</b></p>
                <p>News emails → <b className="text-slate-700">{emailSettingsMeta.newsEmailTo || emailSettingsMeta.emailTo || 'not configured'}</b> · SMTP {emailSettingsMeta.smtpConfigured ? 'ok' : 'missing'}</p>
              </div>
              <p className="text-[11px] font-medium text-slate-400">MT5 push (MetaQuotes ID) and WhatsApp delivery — coming soon. Email is the live channel.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── DELIVERY LOG ── */}
      {activeTab === 'log' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-bold text-slate-900">Recent delivery log</h3>
            <p className="text-xs font-medium text-slate-500">Every email attempt, newest first.</p>
          </div>
          <div className="max-h-[560px] divide-y divide-slate-100 overflow-y-auto">
            {logs.map((log) => (
              <div key={log.id} className="flex items-center gap-3 px-5 py-2 transition-colors hover:bg-slate-50/60">
                {log.status === 'Success' ? <CheckCircle2 size={15} className="shrink-0 text-emerald-500" /> : <XCircle size={15} className="shrink-0 text-red-500" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] font-semibold text-slate-600">{log.signalId || log.recipient}</p>
                  {log.error && <p className="truncate text-[11px] font-semibold text-red-500">{log.error}</p>}
                </div>
                <span className="shrink-0 text-[11px] font-medium text-slate-400">{formatBdDateTime(log.timestamp)}</span>
              </div>
            ))}
            {!logs.length && <p className="px-5 py-8 text-center text-xs font-medium text-slate-400">No email delivery logs yet.</p>}
          </div>
        </div>
      )}

      {/* ── Sticky save bar (appears only with unsaved changes) ── */}
      {(dirty || emailSettingsStatus) && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="flex w-full max-w-xl items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/95 py-2 pl-4 pr-2 shadow-lg backdrop-blur">
            {dirty ? (
              <span className="flex items-center gap-2 text-xs font-bold text-slate-700">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />Unsaved changes
              </span>
            ) : (
              <span className="flex items-center gap-2 text-xs font-bold text-emerald-600">
                <CheckCircle2 size={14} />{emailSettingsStatus}
              </span>
            )}
            {dirty && (
              <button
                onClick={handleSaveEmailSettings}
                disabled={savingEmailSettings}
                className="inline-flex items-center gap-2 rounded-xl bg-gold-500 px-5 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-gold-600 disabled:opacity-60"
              >
                <Send size={14} /> {savingEmailSettings ? 'Saving…' : 'Save all changes'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

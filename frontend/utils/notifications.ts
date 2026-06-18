/**
 * Programmatically play a premium double-beep chime using the Web Audio API.
 * This is fully client-side and requires no external audio assets.
 */
export function playAlertSound() {
  if (typeof window === 'undefined') return;
  
  const soundEnabled = window.localStorage.getItem('aura-gold-sound-alerts') !== 'false';
  if (!soundEnabled) return;

  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    // Premium dual-note synth chime (C5 to G5)
    osc.frequency.setValueAtTime(523.25, now); // C5
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc.frequency.setValueAtTime(783.99, now + 0.12); // G5
    gain.gain.setValueAtTime(0.15, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

    osc.start(now);
    osc.stop(now + 0.42);
  } catch (error) {
    console.warn('[notifications] Failed to play alert sound:', error);
  }
}

/**
 * Request permission for browser push notifications.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  return Notification.requestPermission();
}

/**
 * Display a client-side HTML5 desktop notification if permissions and settings allow.
 */
export function showBrowserNotification(
  title: string,
  options?: NotificationOptions & { bypassSettings?: boolean }
) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;

  const bypass = options?.bypassSettings === true;
  const notificationsEnabled = window.localStorage.getItem('aura-gold-browser-notifications') !== 'false';
  
  if (!bypass && !notificationsEnabled) return;

  if (Notification.permission === 'granted') {
    try {
      const { bypassSettings, ...notificationOptions } = options || {};
      new Notification(title, {
        icon: '/favicon.ico', // fallback icon
        ...notificationOptions,
      });
    } catch (e) {
      console.warn('[notifications] Failed to instantiate Notification class:', e);
    }
  }
}

export const APP_TIME_ZONE = 'Asia/Dhaka';

const dateFormatter = new Intl.DateTimeFormat('en-BD', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('en-BD', {
  timeZone: APP_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-BD', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

function parseDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatBdDateTime(value?: string | null, fallback = 'n/a') {
  const date = parseDate(value);
  return date ? `${dateTimeFormatter.format(date)} BDT` : (value || fallback);
}

export function formatBdTime(value?: string | null, fallback = 'Never') {
  const date = parseDate(value);
  return date ? `${timeFormatter.format(date)} BDT` : (value || fallback);
}

export function formatBdDateParts(value?: string | null) {
  const date = parseDate(value);
  if (!date) return { date: value || 'n/a', time: '' };
  return { date: dateFormatter.format(date), time: `${timeFormatter.format(date)} BDT` };
}

export function bdDateStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

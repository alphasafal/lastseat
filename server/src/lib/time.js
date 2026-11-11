/**
 * Current UTC offset of an IANA time zone, in minutes east of UTC (Asia/Kolkata -> 330).
 * Stored on the participant so suggestions can be scored without time zone maths per request.
 */
export function utcOffsetMinutes(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((wallClockAsUtc - at.getTime()) / 60_000);
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `UTC${sign}${hours}${mins ? `:${String(mins).padStart(2, '0')}` : ''}`;
}

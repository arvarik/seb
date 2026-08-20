export function easternKickoff(
  date: string,
  time: string | null,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time ?? '')) {
    return null;
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = (time ?? '').split(':').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null;
  }

  const target = Date.UTC(year, month - 1, day, hour, minute);
  let estimate = target;
  for (let index = 0; index < 3; index += 1) {
    const parts = easternParts(new Date(estimate));
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    estimate += target - represented;
  }
  return new Date(estimate);
}

function easternParts(date: Date): {
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

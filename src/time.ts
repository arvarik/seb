const EASTERN_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

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
  const calendar = new Date(target);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
    calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
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
  const matches = (instant: number): boolean => {
    const value = easternParts(new Date(instant));
    return value.year === year && value.month === month && value.day === day && value.hour === hour && value.minute === minute;
  };
  // Reject nonexistent or ambiguous daylight-saving wall times.
  if (!matches(estimate) || matches(estimate - 3_600_000) || matches(estimate + 3_600_000)) return null;
  return new Date(estimate);
}

function easternParts(date: Date): {
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
} {
  const parts = EASTERN_FORMATTER.formatToParts(date);
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

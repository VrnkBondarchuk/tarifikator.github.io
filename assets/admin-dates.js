function localDayStart(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('Выберите корректные даты.');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (year < 1 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('Выберите корректные даты.');
  }
  return date;
}

export function localDateRange(from = '', to = '') {
  const start = from ? localDayStart(from) : null;
  const end = to ? localDayStart(to) : null;
  if (start && end && start > end) {
    throw new Error('Дата «С» должна быть не позже даты «По».');
  }
  // Advance the calendar date, not 24 hours: daylight-saving days can be shorter or longer.
  if (end) {
    end.setDate(end.getDate() + 1);
    end.setHours(0, 0, 0, 0);
  }
  return { from: start ? start.toISOString() : '', to: end ? end.toISOString() : '' };
}

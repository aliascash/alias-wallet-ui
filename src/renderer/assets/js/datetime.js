// Every date in the UI as dd/mm/yy HH:MM, e.g. 12/11/26 09:45. The client
// asked for this fixed form; toLocaleString() gave "11/11/2026, 12:17:36",
// too wide for the transaction table's date column.
function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  const two = (n) => String(n).padStart(2, '0');
  return two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + two(d.getFullYear() % 100)
    + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

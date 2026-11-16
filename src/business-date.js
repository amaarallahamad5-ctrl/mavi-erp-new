'use strict';
// SQLite timestamps are stored as UTC; the business reports use Cairo's actual
// time zone, including seasonal changes. A stored date-only value stays a date.
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone:'Africa/Cairo', year:'numeric', month:'2-digit', day:'2-digit' });
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === value;
}
function cairoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input=value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return validDate(input) ? input : null;
  let stamp=input.replace(' ','T');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(stamp)) stamp+='Z';
  const d=new Date(stamp);
  if (Number.isNaN(d.getTime())) return null;
  const parts=Object.fromEntries(formatter.formatToParts(d).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
module.exports = { validDate, cairoDate };

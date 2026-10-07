import { useEffect, useId, useState } from "react";
import { manilaToday, formatReportValue } from "./reportFormat.js";
import { historyMonthDays, shiftHistoryDate, shiftHistoryMonth, validHistoryDate } from "./historyCalendar.js";

export default function HistoryCalendar({ selection, onChange, dateCounts, recordCount }) {
  const [expanded, setExpanded] = useState(false);
  const [month, setMonth] = useState(selection.date.slice(0, 7));
  const calendarId = useId();
  const today = manilaToday();
  useEffect(() => setMonth(selection.date.slice(0, 7)), [selection.date]);
  const chooseDate = (date) => {
    if (validHistoryDate(date)) onChange({ mode: "daily", date });
  };
  const daily = selection.mode === "daily";
  const monthLabel = new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`));

  return <section className="history-calendar" aria-label="History calendar filter">
    <div className="history-calendar-toolbar">
      <div className="history-view-toggle" aria-label="History view">
        <button type="button" aria-pressed={daily} onClick={() => onChange({ ...selection, mode: "daily" })}>Daily View</button>
        <button type="button" aria-pressed={!daily} onClick={() => onChange({ ...selection, mode: "all" })}>All History</button>
      </div>
      <div className="history-date-controls">
        <button type="button" className="history-calendar-arrow" aria-label="Previous day" disabled={!daily || selection.date <= "0001-01-01"} onClick={() => chooseDate(shiftHistoryDate(selection.date, -1))}>‹</button>
        <label className="history-date-label"><span>View date</span><input type="date" min="0001-01-01" max="9999-12-31" value={selection.date} onChange={(event) => chooseDate(event.target.value)} /></label>
        <button type="button" className="history-calendar-arrow" aria-label="Next day" disabled={!daily || selection.date >= "9999-12-31"} onClick={() => chooseDate(shiftHistoryDate(selection.date, 1))}>›</button>
        <button type="button" onClick={() => chooseDate(today)}>Today</button>
      </div>
      <button type="button" aria-expanded={expanded} aria-controls={calendarId} onClick={() => setExpanded((current) => !current)}>{expanded ? "Hide calendar" : "Show calendar"}</button>
    </div>
    <p className="history-calendar-caption" role="status">{daily ? formatReportValue(selection.date, "date") : "All dates"} · {recordCount} record{recordCount === 1 ? "" : "s"} <span>Philippine time (Asia/Manila)</span></p>
    {expanded && <div className="history-calendar-month" id={calendarId}>
      <header><button type="button" className="history-calendar-arrow" aria-label="Previous month" disabled={month <= "0001-01"} onClick={() => setMonth(shiftHistoryMonth(month, -1))}>‹</button><strong>{monthLabel}</strong><button type="button" className="history-calendar-arrow" aria-label="Next month" disabled={month >= "9999-12"} onClick={() => setMonth(shiftHistoryMonth(month, 1))}>›</button></header>
      <div className="history-calendar-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span className="history-calendar-weekday" key={day}>{day}</span>)}
        {historyMonthDays(month).map((date, index) => date ? <button type="button" key={date} className={`history-calendar-day ${date === today ? "is-today" : ""}`} aria-pressed={daily && date === selection.date} aria-current={date === today ? "date" : undefined} aria-label={`${formatReportValue(date, "date")}, ${dateCounts[date] || 0} records`} onClick={() => chooseDate(date)}>
          <span>{Number(date.slice(8))}</span><small>{dateCounts[date] ? <>{dateCounts[date]}<span className="history-day-count-label"> record{dateCounts[date] === 1 ? "" : "s"}</span></> : "—"}</small>
        </button> : <span key={`empty-${index}`} />)}
      </div>
      <p>Choose a day to view its records. Counts follow any active vendor filter.</p>
    </div>}
  </section>;
}

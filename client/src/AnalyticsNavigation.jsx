import "./analyticsNavigation.css";

export default function AnalyticsNavigation({ prefix, sections, value, onChange }) {
  return <nav className="analytics-navigation" aria-label={`${prefix === "profit-analysis" ? "Profit" : "Sales"} sections`}>
    {sections.map(({ id, label }) => <button type="button" key={id} aria-pressed={value === id} aria-controls={`${prefix}-${id}`} onClick={() => onChange(id)}>{label}</button>)}
  </nav>;
}

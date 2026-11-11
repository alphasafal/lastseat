import { useEffect, useId, useRef } from 'react';
import { SKILLS, initials, skillLabel } from '../lib/format.js';

/**
 * The seats of a team, drawn as a row: one block per seat, filled or open.
 * This is the one picture the whole product is about, so it appears wherever a team does.
 */
export function SeatStrip({ team, size = 'md', pendingUserId = null }) {
  const open = Array.from({ length: team.openSeats });
  return (
    <div
      className={`seats seats-${size}`}
      role="img"
      aria-label={`${team.memberCount} of ${team.maxSize} seats taken`}
    >
      {team.members.map((member) => (
        <span
          key={member.userId}
          className={[
            'seat seat-taken',
            member.userId === team.leaderId ? 'seat-leader' : '',
            member.userId === pendingUserId ? 'seat-pending' : '',
          ].join(' ')}
          title={member.userId === team.leaderId ? `${member.name} (leader)` : member.name}
        >
          {initials(member.name)}
        </span>
      ))}
      {open.map((_, index) => (
        <span key={`open-${index}`} className="seat seat-open" />
      ))}
    </div>
  );
}

export function Avatar({ name }) {
  return (
    <span className="avatar" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function SkillList({ skills, highlight = [], empty = null }) {
  if (!skills?.length) return empty;
  return (
    <ul className="chips">
      {skills.map((skill) => (
        <li key={skill} className={highlight.includes(skill) ? 'chip chip-match' : 'chip'}>
          {skillLabel(skill)}
        </li>
      ))}
    </ul>
  );
}

/** Checkboxes styled as chips: native keyboard and screen-reader behaviour for free. */
export function SkillPicker({ legend, value, onChange, max, hint }) {
  const toggle = (skill) => {
    if (value.includes(skill)) onChange(value.filter((s) => s !== skill));
    else if (value.length < max) onChange([...value, skill]);
  };
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      {hint && <p className="hint">{hint}</p>}
      <div className="chip-picker">
        {SKILLS.map((skill) => (
          <label key={skill} className="chip-toggle">
            <input
              type="checkbox"
              checked={value.includes(skill)}
              disabled={!value.includes(skill) && value.length >= max}
              onChange={() => toggle(skill)}
            />
            <span>{skillLabel(skill)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Tabs following the ARIA pattern: arrow keys move between tabs, Tab moves into the panel. */
export function Tabs({ tabs, active, onChange, label }) {
  const refs = useRef({});
  const onKeyDown = (event) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let next = null;
    if (step) next = tabs[(index + step + tabs.length) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs.at(-1);
    if (!next) return;
    event.preventDefault();
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(node) => (refs.current[tab.id] = node)}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          className="tab"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="tab-count">{tab.count.toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A modal built on <dialog>: the browser traps focus, handles Escape and restores focus. */
export function Dialog({ open, onClose, title, children }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-button" onClick={onClose}>
              <span className="sr-only">Close</span>
              <span aria-hidden="true">×</span>
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Field({ label, hint, error, children }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {children({
        id,
        'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function LiveBadge({ status }) {
  const text = { live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting' }[status];
  return (
    <span className={`live live-${status}`} title="Updates appear without refreshing">
      <span className="live-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

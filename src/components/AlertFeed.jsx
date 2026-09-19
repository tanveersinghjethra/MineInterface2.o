import React from 'react';
import { BellRing, Check, MessageSquare, Mail } from 'lucide-react';

const tone = { Critical: 'crit', High: 'high', Moderate: 'mod' };

export default function AlertFeed({ alerts, onAcknowledge }) {
  return (
    <section className="panel alertFeed">
      <div className="panelHead">
        <div>
          <div className="titleRow">
            <h2><BellRing size={16} /> Early warning log</h2>
            <span className="zonePill">{alerts.length} records</span>
          </div>
          <small>Every message sent to the safety officer, with delivery state.</small>
        </div>
      </div>

      {alerts.length === 0 ? (
        <p className="tableEmpty">
          No warnings issued yet. The scorer raises one automatically when a node
          crosses the action level.
        </p>
      ) : (
        <ul className="alertList">
          {alerts.map((a) => (
            <li key={a.id} className={tone[a.severity] || 'mod'}>
              <div className="alertHead">
                <b>{a.title}</b>
                <span className={`alertStatus ${a.status}`}>{a.status}</span>
              </div>
              <p>{a.body}</p>
              <div className="alertMeta">
                <span>{new Date(a.created_at).toLocaleString()}</span>
                {a.channels?.includes('sms') && <span><MessageSquare size={12} /> SMS</span>}
                {a.channels?.includes('email') && <span><Mail size={12} /> Email</span>}
                <span>{Array.isArray(a.recipients) ? a.recipients.length : 0} recipients</span>
                {a.status !== 'acknowledged' && (
                  <button onClick={() => onAcknowledge(a.id)}>
                    <Check size={12} /> Acknowledge
                  </button>
                )}
                {a.acknowledged_by && <span>ack by {a.acknowledged_by}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

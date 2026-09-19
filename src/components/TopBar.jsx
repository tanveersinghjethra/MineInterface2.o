import React from 'react';
import { Bell, HardHat, Radio, ShieldCheck } from 'lucide-react';

const LABEL = { live: 'Live', connecting: 'Connecting', error: 'Reconnecting' };

export default function TopBar({ site, connection, lastSync, critical }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo"><ShieldCheck size={22} /></div>
        <div>
          <b>Mine<span>Guard</span></b>
          <small>Surface mesh subsidence early warning</small>
        </div>
      </div>

      <nav className="topnav">
        <button className="navActive">Overview</button>
        <button onClick={() => document.querySelector('.charts')?.scrollIntoView({ behavior: 'smooth' })}>
          Telemetry
        </button>
        <button onClick={() => document.querySelector('.mapPanel')?.scrollIntoView({ behavior: 'smooth' })}>
          Risk map
        </button>
        <button onClick={() => document.querySelector('.alertFeed')?.scrollIntoView({ behavior: 'smooth' })}>
          Alerts {critical > 0 && <span className="navBadge">{critical}</span>}
        </button>
      </nav>

      <div className="headerRight">
        <div className={`conn ${connection}`}>
          <i /> {LABEL[connection] || connection}
        </div>
        <div className="syncText">
          <Radio size={13} /> {lastSync ? lastSync.toLocaleTimeString() : '—'}
        </div>
        <button className="headerIcon" aria-label="Notifications">
          <Bell size={17} />
          {critical > 0 && <i className="dot" />}
        </button>
        <div className="siteChip"><HardHat size={14} /> {site?.code || '—'}</div>
      </div>
    </header>
  );
}

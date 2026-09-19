import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

export default function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.tone}`} role="status" aria-live="polite">
      {toast.tone === 'bad' ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
      {toast.message}
    </div>
  );
}

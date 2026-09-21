import { Sparkles } from 'lucide-react';

// The in-app TranslyAi logo: the orange sparkles mark. (The "T" artwork is only used for the favicon and install icons.)
export default function BrandMark({ className = '' }) {
  return <div className={`brand-mark ${className}`.trim()} aria-hidden="true"><Sparkles size={16} /></div>;
}

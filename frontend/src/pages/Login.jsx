import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import logoImg from '../assets/vegietrack-logo.png';
import loginBg from '../assets/login-background.jpg';

export default function Login() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { loginDemo } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const enterDemo = async () => {
    setError('');
    setLoading(true);
    try {
      await loginDemo();
      const redirectTo = location.state?.from?.pathname || '/';
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const data = err.response?.data;
      setError(data?.message || 'The demo is temporarily unavailable. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gray-900 bg-cover bg-center p-4"
      style={{ backgroundImage: `linear-gradient(rgba(12, 27, 18, 0.78), rgba(12, 27, 18, 0.78)), url(${loginBg})` }}
    >
      <div className="w-full max-w-lg">
        <section className="rounded-3xl bg-white p-6 shadow-2xl sm:p-10">
          <div className="mb-7 flex flex-col items-center text-center">
            <img src={logoImg} alt="VegieTrack logo" className="mb-4 h-20 w-20 rounded-2xl object-cover shadow-sm" />
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800">
              Portfolio demo
            </span>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-gray-900">VegieTrack</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-gray-600">
              Explore a complete produce inventory and sales workspace using fictional sample data.
            </p>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={enterDemo}
            disabled={loading}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-700 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-800 disabled:cursor-wait disabled:opacity-70"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}
            {loading ? 'Opening demo workspace…' : 'Enter the demo'}
          </button>

          <div className="mt-5 flex gap-3 rounded-xl border border-emerald-100 bg-emerald-50/70 p-4 text-left">
            <ShieldCheck className="mt-0.5 shrink-0 text-emerald-700" size={19} />
            <p className="text-xs leading-5 text-emerald-950">
              This public workspace uses an isolated demo database. Sales and inventory changes stay in demo data;
              account, settings, deletion, and other administrative actions are disabled.
            </p>
          </div>
        </section>
        <p className="mt-4 text-center text-xs text-white/70">
          VegieTrack · Inventory and market operations
        </p>
      </div>
    </div>
  );
}

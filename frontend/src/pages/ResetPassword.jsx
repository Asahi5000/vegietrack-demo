import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import api from '../api/axios';
import logoImg from '../assets/vegietrack-logo.png';
import loginBg from '../assets/login-background.jpg';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [tokenValid, setTokenValid] = useState(false);
  const [validationMessage, setValidationMessage] = useState('');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setChecking(false);
      setTokenValid(false);
      setValidationMessage('No reset token was provided.');
      return;
    }
    api.get(`/auth/reset-password/${token}`)
      .then(() => setTokenValid(true))
      .catch((err) => {
        setTokenValid(false);
        setValidationMessage(err.response?.data?.message || 'This reset link is invalid or has expired.');
      })
      .finally(() => setChecking(false));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters long');
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/auth/reset-password', { token, password });
      setSuccess(res.data.message);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-gray-900 bg-cover bg-center p-3 sm:p-4" style={{ backgroundImage: `linear-gradient(rgba(17, 24, 39, 0.72), rgba(17, 24, 39, 0.72)), url(${loginBg})` }}>

      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-2xl p-5 sm:p-8">
          <div className="flex flex-col items-center mb-6">
            <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-primary-600 flex items-center justify-center mb-3 overflow-hidden">
              <img src={logoImg} alt="VegieTrack logo" className="w-full h-full object-cover" />
            </div>
            <h1 className="text-2xl font-bold text-gray-800">Reset Password</h1>
            <p className="text-sm text-gray-500 mt-1">Choose a new password for your account</p>
          </div>

          {checking ? (
            <div className="flex items-center justify-center gap-2 text-gray-500 py-6">
              <Loader2 className="animate-spin" size={18} /> Verifying reset link...
            </div>
          ) : success ? (
            <div className="text-center space-y-3 py-4">
              <CheckCircle2 className="mx-auto text-emerald-500" size={40} />
              <p className="text-sm text-gray-700">{success}</p>
              <p className="text-xs text-gray-400">Redirecting to login...</p>
            </div>
          ) : !tokenValid ? (
            <div className="text-center space-y-3 py-4">
              <XCircle className="mx-auto text-red-500" size={40} />
              <p className="text-sm text-gray-700">{validationMessage}</p>
              <Link to="/login" className="inline-block text-sm text-primary-600 hover:text-primary-800 font-medium">
                Back to login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-2" role="alert">
                  {error}
                </div>
              )}
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                <div className="relative">
                  <input
                    id="new-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent pr-10"
                    placeholder="Enter new password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
                <input
                  id="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="Re-enter new password"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {loading && <Loader2 className="animate-spin" size={18} />}
                {loading ? 'Resetting...' : 'Reset Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

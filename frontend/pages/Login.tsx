import React, { useState } from 'react';
import { TrendingUp, Lock, Mail, AlertCircle, Info } from 'lucide-react';

interface LoginProps {
  onLogin: (remember: boolean) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (email === 'admin@auragold.com' && password === 'admin123') {
      setError('');
      onLogin(remember);
    } else {
      setError('Invalid credentials. Use admin@auragold.com / admin123');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-3xl shadow-floating border border-slate-100 p-8 sm:p-10">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-gold-50 rounded-2xl flex items-center justify-center border border-gold-100 mb-5 shadow-sm transform rotate-3">
              <TrendingUp size={32} className="text-gold-500 transform -rotate-3" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Welcome to AURA<span className="text-gold-500">GOLD</span></h1>
            <p className="text-slate-500 text-sm mt-2 font-medium">Premium MT5 Alert System</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl flex items-center gap-2 text-sm font-medium">
                <AlertCircle size={18} className="shrink-0" />
                {error}
              </div>
            )}

            {/* Demo Credentials Hint */}
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-start gap-3">
              <Info size={18} className="text-blue-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-blue-600 font-semibold uppercase tracking-wider mb-1">Demo Access</p>
                <p className="text-sm text-slate-700 font-medium">Email: <span className="font-mono bg-white px-1 py-0.5 rounded border border-blue-100">admin@auragold.com</span></p>
                <p className="text-sm text-slate-700 font-medium mt-1">Pass: <span className="font-mono bg-white px-1 py-0.5 rounded border border-blue-100">admin123</span></p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">Email Address</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                  <Mail size={18} className="text-slate-400" />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="block w-full pl-10 pr-4 py-3 border border-slate-200 rounded-xl bg-slate-50 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all duration-200"
                  placeholder="admin@auragold.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                  <Lock size={18} className="text-slate-400" />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-10 pr-4 py-3 border border-slate-200 rounded-xl bg-slate-50 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all duration-200"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center">
                <input
                  id="remember-me"
                  name="remember-me"
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 bg-white border-slate-300 rounded text-gold-500 focus:ring-gold-500"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm font-medium text-slate-600">
                  Remember me
                </label>
              </div>
              <div className="text-sm">
                <a href="#" className="font-semibold text-gold-600 hover:text-gold-500 transition-colors">
                  Forgot password?
                </a>
              </div>
            </div>

            <button
              type="submit"
              className="w-full flex justify-center py-3.5 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-gold-500 hover:bg-gold-600 hover:shadow-md hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gold-500 transition-all duration-200 mt-4"
            >
              Sign In to Dashboard
            </button>
          </form>
        </div>
        <p className="text-center text-slate-400 text-xs mt-8 font-medium">
          &copy; 2024 Aura Gold Trading Systems. All rights reserved.
        </p>
      </div>
    </div>
  );
}

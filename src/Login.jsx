import React, { useState } from 'react';
import { supabase, isSupabaseConfigured } from './supabaseClient';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!isSupabaseConfigured) {
      setError('Supabase is not configured — check your .env file.');
      return;
    }

    setIsLoading(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setIsLoading(false);

    if (signInError) {
      setError(signInError.message);
    }
  };

  return (
    <div className="min-h-screen bg-[#0d0f12] text-gray-200 flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-sm bg-[#14161a] border border-[#23262e] rounded-lg shadow-2xl p-8">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-bold tracking-wider text-white">COMMAND CENTER</h1>
          <p className="text-xs text-gray-500 mt-1 uppercase tracking-widest">Sign in to continue</p>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-6 p-4 rounded-md text-sm border bg-red-900/20 border-red-500/50 text-red-400">
            Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 rounded-md text-sm border bg-red-900/20 border-red-500/50 text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white focus:outline-none focus:border-[#f3a910] transition-colors placeholder-gray-700"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
              className="w-full bg-[#0d0f12] border border-[#23262e] rounded p-3 text-sm text-white focus:outline-none focus:border-[#f3a910] transition-colors placeholder-gray-700"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className={`w-full py-4 rounded font-bold uppercase tracking-wider text-sm transition-all duration-200 mt-2 shadow-lg bg-[#f3a910] hover:bg-[#d9930b] text-black ${isLoading ? 'opacity-70 cursor-not-allowed' : ''
              }`}
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;

import { FormEvent, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ShoppingBag } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const redirectTo = useMemo(() => {
    const from = (location.state as any)?.from;
    return typeof from === 'string' ? from : '/';
  }, [location.state]);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await login({ username: username.trim(), password, rememberMe });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen text-gray-900 flex items-center justify-center px-4 bg-gradient-to-b from-orange-50 via-white to-white">
      <div className="w-full max-w-md">
        <div className="bg-white border border-orange-100 rounded-3xl shadow-sm p-6">
          <div className="flex items-center gap-3">
            <div className="bg-orange-500 p-3 rounded-2xl shadow-sm">
              <ShoppingBag className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">登录</h1>
              <p className="mt-0.5 text-sm text-gray-500">请输入系统账号密码</p>
            </div>
          </div>

          <form className="mt-6 space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">用户名</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 border border-gray-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                autoComplete="username"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 border border-gray-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-orange-500"
                autoComplete="current-password"
                required
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700 select-none">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="rounded border-gray-300"
              />
              记住登录（30 天）
            </label>

            {error ? <div className="text-sm text-red-600">{error}</div> : null}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full px-4 py-3 rounded-2xl font-bold text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50"
            >
              {isSubmitting ? '登录中...' : '登录'}
            </button>

            <div className="text-sm text-gray-600">
              没有账号？
              <Link to="/register" className="ml-1 text-orange-600 hover:text-orange-700 font-medium">
                使用邀请码注册
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

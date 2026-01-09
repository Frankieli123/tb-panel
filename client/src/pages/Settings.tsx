import { useEffect, useState } from 'react';
import { Settings as SettingsIcon, Save, CheckCircle2, Shield, Clock, Loader2, AlertTriangle, Moon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { ScraperConfig } from '../types';

export default function Settings() {
  const [config, setConfig] = useState<ScraperConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setIsLoading(true);
    try {
      const data = await api.getScraperConfig();
      const humanDelayScale =
        typeof data.humanDelayScale === 'number' && Number.isFinite(data.humanDelayScale)
          ? data.humanDelayScale
          : 1;
      setConfig({ ...data, humanDelayScale });
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaveStatus('saving');
    try {
      await api.updateScraperConfig(config);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (error) {
      console.error('Failed to save config:', error);
      setSaveStatus('idle');
    }
  };

  const updateConfig = (updates: Partial<ScraperConfig>) => {
    if (!config) return;
    setConfig({ ...config, ...updates });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!config) {
    return <div className="text-center text-gray-500">加载失败</div>;
  }

  const hasValidationError = config.minDelay > config.maxDelay;
  const hasQuietHoursError = config.quietHoursEnabled && config.quietHoursStart === config.quietHoursEnd;
  const hasDelayScaleError = config.humanDelayScale < 0.2 || config.humanDelayScale > 2.0;
  const isSaveDisabled = saveStatus === 'saving' || hasValidationError || hasQuietHoursError || hasDelayScaleError;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <SettingsIcon className="w-6 h-6 text-orange-500" />
          系统设置
        </h2>
        <p className="text-gray-500 mt-1">配置爬虫行为和系统参数</p>
      </div>

      {/* Anti-detection Delay */}
      <section className="bg-white rounded-2xl shadow-sm border border-orange-200 overflow-hidden ring-1 ring-orange-500/10">
        <div className="p-6 border-b border-gray-100 bg-orange-50/30">
          <h3 className="font-bold text-gray-800 flex items-center gap-2 text-lg">
            <Shield className="w-5 h-5 text-orange-600" />
            防风控随机延迟
          </h3>
          <p className="text-sm text-gray-500 mt-1 ml-7">
            在每次抓取任务之间增加随机等待时间，模拟真实用户行为，降低被淘宝封锁的风险。
          </p>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">最小延迟</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  value={config.minDelay}
                  onChange={(e) => updateConfig({ minDelay: parseInt(e.target.value) || 0 })}
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-200 rounded-xl focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition-all"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">秒</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">最大延迟</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  value={config.maxDelay}
                  onChange={(e) => updateConfig({ maxDelay: parseInt(e.target.value) || 0 })}
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-200 rounded-xl focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition-all"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">秒</span>
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-2">操作速度倍率（影响加购/购物车抓取）</label>
              <div className="relative">
                <input
                  type="number"
                  min="0.2"
                  max="2.0"
                  step="0.1"
                  value={config.humanDelayScale}
                  onChange={(e) => updateConfig({ humanDelayScale: Number.parseFloat(e.target.value) || 1 })}
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-200 rounded-xl focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition-all"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">倍</span>
              </div>
              <p className="text-xs text-gray-400 mt-2">范围：0.2（更快）~ 2.0（更慢），默认 1.0</p>
            </div>
          </div>

          {hasValidationError && (
            <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
              <AlertTriangle className="w-4 h-4" />
              最小延迟不能大于最大延迟
            </div>
          )}
          {hasDelayScaleError && (
            <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
              <AlertTriangle className="w-4 h-4" />
              操作速度倍率必须在 0.2 到 2.0 之间
            </div>
          )}

          <div className="text-sm text-gray-500 bg-gray-50 p-4 rounded-xl">
            <span className="font-medium text-gray-700">当前生效：</span>
            每次抓取将在 <span className="text-orange-600 font-bold">{config.minDelay}</span> 到 <span className="text-orange-600 font-bold">{config.maxDelay}</span> 秒之间随机等待，操作间隔按 <span className="text-orange-600 font-bold">{config.humanDelayScale}x</span> 缩放。
          </div>
        </div>
      </section>

      {/* Quiet Hours */}
      <section className="bg-white rounded-2xl shadow-sm border border-indigo-200 overflow-hidden ring-1 ring-indigo-500/10">
        <div className="p-6 border-b border-gray-100 bg-indigo-50/30">
          <h3 className="font-bold text-gray-800 flex items-center gap-2 text-lg">
            <Moon className="w-5 h-5 text-indigo-600" />
            系统静默时间
          </h3>
          <p className="text-sm text-gray-500 mt-1 ml-7">
            设置系统的休息时间段，在此期间将暂停所有的自动抓取任务。
          </p>
        </div>
        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">启用静默时间</span>
            <button
              onClick={() => updateConfig({ quietHoursEnabled: !config.quietHoursEnabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                config.quietHoursEnabled ? 'bg-indigo-600' : 'bg-gray-200'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  config.quietHoursEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {config.quietHoursEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">开始时间</label>
                <input
                  type="time"
                  value={config.quietHoursStart}
                  onChange={(e) => updateConfig({ quietHoursStart: e.target.value })}
                  className="w-full px-4 py-2.5 border border-gray-200 rounded-xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">结束时间</label>
                <input
                  type="time"
                  value={config.quietHoursEnd}
                  onChange={(e) => updateConfig({ quietHoursEnd: e.target.value })}
                  className="w-full px-4 py-2.5 border border-gray-200 rounded-xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all"
                />
              </div>
            </div>
          )}

          {hasQuietHoursError && (
            <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
              <AlertTriangle className="w-4 h-4" />
              开始时间和结束时间不能相同
            </div>
          )}

          <div className="text-sm text-gray-500 bg-gray-50 p-4 rounded-xl space-y-1">
            <p><span className="font-medium text-gray-700">说明：</span> 时间判定基于服务器时区。</p>
            <p>支持跨夜设置（例如：23:00 到 06:00），系统会自动处理。</p>
            <p className="pt-2 text-indigo-600">
              提示：企业微信/钉钉/飞书的通知配置请前往 <Link to="/notifications" className="underline hover:text-indigo-800">通知设置</Link> 页面。
            </p>
          </div>
        </div>
      </section>

      {/* Polling Interval */}
      <section className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-gray-50/50">
          <h3 className="font-bold text-gray-800 flex items-center gap-2 text-lg">
            <Clock className="w-5 h-5 text-gray-600" />
            轮询间隔
          </h3>
          <p className="text-sm text-gray-500 mt-1 ml-7">
            系统检查所有监控商品价格的频率。建议不要设置过短，以免触发频繁访问限制。
          </p>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">检查周期</label>
              <div className="relative">
                <input
                  type="number"
                  min="10"
                  value={config.pollingInterval}
                  onChange={(e) => updateConfig({ pollingInterval: Math.max(10, parseInt(e.target.value) || 10) })}
                  className="w-full pl-4 pr-12 py-2.5 border border-gray-200 rounded-xl focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition-all"
                />
                <span className="absolute right-4 top-2.5 text-gray-400 text-sm">分钟</span>
              </div>
              <p className="text-xs text-gray-400 mt-2">最小值：10 分钟</p>
            </div>
            <div></div>
          </div>

          <div className="text-sm text-gray-500 bg-gray-50 p-4 rounded-xl">
            <span className="font-medium text-gray-700">当前生效：</span>
            系统将每 <span className="text-orange-600 font-bold">{config.pollingInterval}</span> 分钟检查一次所有监控商品的价格。
          </div>
        </div>
      </section>

      {/* Save Action Bar */}
      <div className="sticky bottom-20 md:bottom-4 bg-white/80 backdrop-blur-md border border-gray-200 p-4 rounded-2xl shadow-lg flex justify-between items-center">
        <div className="text-sm text-gray-500 pl-2">
          {saveStatus === 'saved' ? (
            <span className="flex items-center gap-2 text-green-600 font-medium">
              <CheckCircle2 className="w-4 h-4" /> 设置已保存
            </span>
          ) : (
            <span>修改后请记得保存</span>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={isSaveDisabled}
          className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-white transition-all ${
            saveStatus === 'saved'
              ? 'bg-green-500'
              : 'bg-gray-900 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed'
          }`}
        >
          {saveStatus === 'saving' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saveStatus === 'saved' ? '已保存' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
